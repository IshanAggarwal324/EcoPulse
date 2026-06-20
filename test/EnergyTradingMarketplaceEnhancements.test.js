const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Sub-module 2.4.3 — listing expiration + partial fills.
 *
 * Covers only the NEW behaviour; the original lifecycle remains covered by
 * TransactionLifecycle.test.js. Expiry timing is advanced with hardhat's
 * network time helpers so no real wall-clock wait is needed.
 */
describe("EnergyTrading 2.4.3 — expiration + partial fills", function () {
  let carbonCredit;
  let energyTrading;
  let owner;
  let seller;
  let buyer;

  const PRICE = ethers.parseEther("100"); // total price for 100 units
  const ENERGY = 100n;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();

    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    carbonCredit = await CarbonCredit.deploy(ethers.parseEther("1000000000"));
    await carbonCredit.waitForDeployment();

    const EnergyTrading = await ethers.getContractFactory("EnergyTrading");
    energyTrading = await EnergyTrading.deploy(await carbonCredit.getAddress());
    await energyTrading.waitForDeployment();

    await carbonCredit.mint(buyer.address, ethers.parseEther("1000"));
    await carbonCredit
      .connect(buyer)
      .approve(await energyTrading.getAddress(), ethers.parseEther("1000"));
  });

  it("lists with expiry and prunes via expireListing", async function () {
    const duration = 60n; // 1 minute
    await expect(
      energyTrading.connect(seller).listEnergyWithExpiry(ENERGY, PRICE, duration),
    ).to.emit(energyTrading, "EnergyListedWithExpiry");

    expect(await energyTrading.isListingActive(0)).to.equal(true);

    // Advance past expiry.
    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine", []);

    // Time-aware view already reports inactive.
    expect(await energyTrading.isListingActive(0)).to.equal(false);

    // Anyone can prune it.
    await expect(energyTrading.connect(buyer).expireListing(0))
      .to.emit(energyTrading, "ListingExpired")
      .withArgs(0, seller.address);

    const listing = await energyTrading.listings(0);
    expect(listing.status).to.equal(3); // Expired
  });

  it("reverts when expiry duration is out of bounds", async function () {
    await expect(
      energyTrading.connect(seller).listEnergyWithExpiry(ENERGY, PRICE, 0),
    ).to.be.revertedWithCustomError(energyTrading, "InvalidDuration");
    await expect(
      energyTrading
        .connect(seller)
        .listEnergyWithExpiry(ENERGY, PRICE, 91n * 24n * 60n * 60n),
    ).to.be.revertedWithCustomError(energyTrading, "InvalidDuration");
  });

  it("cannot purchase an expired (time-lapsed) listing", async function () {
    await energyTrading.connect(seller).listEnergyWithExpiry(ENERGY, PRICE, 60n);
    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      energyTrading.connect(buyer).purchaseEnergy(0),
    ).to.be.revertedWithCustomError(energyTrading, "ListingNotActive");
  });

  it("supports partial fills with proportional pricing", async function () {
    await energyTrading.connect(seller).listEnergy(ENERGY, PRICE); // 100 units @ 100 total => 1/unit

    const sellerBefore = await carbonCredit.balanceOf(seller.address);
    const buyerBefore = await carbonCredit.balanceOf(buyer.address);

    // Buy 30 of 100 units => 30 CC.
    await expect(energyTrading.connect(buyer).purchaseEnergyPartial(0, 30n))
      .to.emit(energyTrading, "EnergyPurchased")
      .withArgs(0, buyer.address, seller.address, 30n, ethers.parseEther("30"));

    // Listing stays active with the reduced remaining amount.
    expect(await energyTrading.isListingActive(0)).to.equal(true);
    const listing = await energyTrading.listings(0);
    expect(listing.energyAmount).to.equal(70n);
    expect(listing.price).to.equal(ethers.parseEther("70"));

    expect(await carbonCredit.balanceOf(seller.address)).to.equal(
      sellerBefore + ethers.parseEther("30"),
    );
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(
      buyerBefore - ethers.parseEther("30"),
    );
  });

  it("marks listing Sold when the final partial fill completes", async function () {
    await energyTrading.connect(seller).listEnergy(ENERGY, PRICE);

    await energyTrading.connect(buyer).purchaseEnergyPartial(0, 40n);
    await energyTrading.connect(buyer).purchaseEnergyPartial(0, 60n);

    const listing = await energyTrading.listings(0);
    expect(listing.status).to.equal(1); // Sold
    expect(listing.energyAmount).to.equal(0n);
    expect(await energyTrading.isListingActive(0)).to.equal(false);
    expect(await carbonCredit.balanceOf(seller.address)).to.equal(PRICE);
  });

  it("reverts partial fill exceeding the remaining amount", async function () {
    await energyTrading.connect(seller).listEnergy(ENERGY, PRICE);
    await expect(
      energyTrading.connect(buyer).purchaseEnergyPartial(0, ENERGY + 1n),
    ).to.be.revertedWithCustomError(energyTrading, "FillExceedsRemaining");
  });

  it("owner can pause and resume the marketplace (emergency stop)", async function () {
    await energyTrading.pause();
    expect(await energyTrading.paused()).to.equal(true);
    await expect(
      energyTrading.connect(seller).listEnergy(ENERGY, PRICE),
    ).to.be.revertedWithCustomError(energyTrading, "EnforcedPause");
    await energyTrading.unpause();
    expect(await energyTrading.paused()).to.equal(false);
  });
});
