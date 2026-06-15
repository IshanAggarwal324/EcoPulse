const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * End-to-end lifecycle mirroring the frontend trading flow:
 * mint → approve → list → purchase → cancel, with event verification.
 */
describe("Complete blockchain transaction lifecycle", function () {
  let carbonCredit;
  let energyTrading;
  let owner;
  let seller;
  let buyer;

  const PRICE = ethers.parseEther("50");
  const ENERGY_AMOUNT = 100n;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();

    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    carbonCredit = await CarbonCredit.deploy(ethers.parseEther("1000000000"));
    await carbonCredit.waitForDeployment();

    const EnergyTrading = await ethers.getContractFactory("EnergyTrading");
    energyTrading = await EnergyTrading.deploy(await carbonCredit.getAddress());
    await energyTrading.waitForDeployment();
  });

  async function mintAndApprove(buyerSigner, amount) {
    await carbonCredit.mint(buyerSigner.address, amount);
    const allowance = await carbonCredit.allowance(
      buyerSigner.address,
      await energyTrading.getAddress(),
    );
    if (allowance < PRICE) {
      await carbonCredit
        .connect(buyerSigner)
        .approve(await energyTrading.getAddress(), amount);
    }
    return allowance;
  }

  it("runs full lifecycle: mint → approve → list → purchase with events and balances", async function () {
    const tradingAddress = await energyTrading.getAddress();

    await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(ethers.parseEther("100"));

    const approveTx = await carbonCredit
      .connect(buyer)
      .approve(tradingAddress, PRICE);
    await approveTx.wait();
    expect(await carbonCredit.allowance(buyer.address, tradingAddress)).to.equal(PRICE);

    await expect(energyTrading.connect(seller).listEnergy(ENERGY_AMOUNT, PRICE))
      .to.emit(energyTrading, "EnergyListed")
      .withArgs(0, seller.address, ENERGY_AMOUNT, PRICE);

    expect(await energyTrading.isListingActive(0)).to.equal(true);
    expect(await energyTrading.nextListingId()).to.equal(1n);

    const sellerBalanceBefore = await carbonCredit.balanceOf(seller.address);
    const buyerBalanceBefore = await carbonCredit.balanceOf(buyer.address);

    await expect(energyTrading.connect(buyer).purchaseEnergy(0))
      .to.emit(energyTrading, "EnergyPurchased")
      .withArgs(0, buyer.address, seller.address, ENERGY_AMOUNT, PRICE);

    expect(await energyTrading.isListingActive(0)).to.equal(false);
    expect(await carbonCredit.balanceOf(seller.address)).to.equal(
      sellerBalanceBefore + PRICE,
    );
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(
      buyerBalanceBefore - PRICE,
    );

    const listing = await energyTrading.listings(0);
    expect(listing.status).to.equal(1); // Sold
  });

  it("skips redundant approval when allowance is already sufficient", async function () {
    const tradingAddress = await energyTrading.getAddress();
    await mintAndApprove(buyer, ethers.parseEther("100"));

    const allowanceBefore = await carbonCredit.allowance(buyer.address, tradingAddress);
    expect(allowanceBefore).to.be.gte(PRICE);

    await energyTrading.connect(seller).listEnergy(ENERGY_AMOUNT, PRICE);
    await energyTrading.connect(buyer).purchaseEnergy(0);

    const allowanceAfter = await carbonCredit.allowance(buyer.address, tradingAddress);
    expect(allowanceAfter).to.equal(allowanceBefore - PRICE);
  });

  it("runs list → cancel lifecycle with ListingCancelled event", async function () {
    await expect(energyTrading.connect(seller).listEnergy(50n, ethers.parseEther("10")))
      .to.emit(energyTrading, "EnergyListed");

    expect(await energyTrading.isListingActive(0)).to.equal(true);

    await expect(energyTrading.connect(seller).cancelListing(0))
      .to.emit(energyTrading, "ListingCancelled")
      .withArgs(0, seller.address);

    expect(await energyTrading.isListingActive(0)).to.equal(false);

    const listing = await energyTrading.listings(0);
    expect(listing.status).to.equal(2); // Cancelled
  });

  it("indexes all lifecycle events via queryFilter (backend sync pattern)", async function () {
    await mintAndApprove(buyer, ethers.parseEther("200"));

    await energyTrading.connect(seller).listEnergy(100n, ethers.parseEther("30"));
    await energyTrading.connect(seller).listEnergy(200n, ethers.parseEther("20"));
    await energyTrading.connect(buyer).purchaseEnergy(0);
    await energyTrading.connect(seller).cancelListing(1);

    const listed = await energyTrading.queryFilter(energyTrading.filters.EnergyListed());
    const purchased = await energyTrading.queryFilter(
      energyTrading.filters.EnergyPurchased(),
    );
    const cancelled = await energyTrading.queryFilter(
      energyTrading.filters.ListingCancelled(),
    );

    expect(listed).to.have.lengthOf(2);
    expect(purchased).to.have.lengthOf(1);
    expect(cancelled).to.have.lengthOf(1);

    expect(listed[0].args.listingId).to.equal(0n);
    expect(purchased[0].args.buyer).to.equal(buyer.address);
    expect(cancelled[0].args.listingId).to.equal(1n);
  });

  it("handles multiple sequential purchases across listings", async function () {
    await mintAndApprove(buyer, ethers.parseEther("500"));

    const priceA = ethers.parseEther("10");
    const priceB = ethers.parseEther("20");

    await energyTrading.connect(seller).listEnergy(10n, priceA);
    await energyTrading.connect(seller).listEnergy(20n, priceB);

    await energyTrading.connect(buyer).purchaseEnergy(0);
    await energyTrading.connect(buyer).purchaseEnergy(1);

    expect(await energyTrading.isListingActive(0)).to.equal(false);
    expect(await energyTrading.isListingActive(1)).to.equal(false);
    expect(await carbonCredit.balanceOf(seller.address)).to.equal(priceA + priceB);
    expect(await energyTrading.nextListingId()).to.equal(2n);
  });

  it("reverts purchase when buyer has insufficient token balance", async function () {
    await carbonCredit.mint(buyer.address, ethers.parseEther("5"));
    await carbonCredit.connect(buyer).approve(await energyTrading.getAddress(), PRICE);

    await energyTrading.connect(seller).listEnergy(ENERGY_AMOUNT, PRICE);

    await expect(
      energyTrading.connect(buyer).purchaseEnergy(0),
    ).to.be.reverted;
  });
});
