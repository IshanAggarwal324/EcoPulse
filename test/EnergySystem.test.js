const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployCarbonCredit, deployEnergyTrading } = require("./helpers/contracts");

describe("Energy System", function () {
  let carbonCredit;
  let energyTrading;
  let owner;
  let seller;
  let buyer;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();

    carbonCredit = await deployCarbonCredit(owner);
    energyTrading = await deployEnergyTrading(await carbonCredit.getAddress());
  });

  describe("Carbon Credit", function () {
    it("Should mint tokens correctly", async function () {
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      expect(await carbonCredit.balanceOf(buyer.address)).to.equal(ethers.parseEther("100"));
    });

    it("Should enforce the supply cap", async function () {
      const capped = await deployCarbonCredit(owner, {
        maxSupply: ethers.parseEther("1000"),
        maxMintPerTx: ethers.parseEther("500"),
      });
      await capped.mint(buyer.address, ethers.parseEther("500"));
      await capped.mint(buyer.address, ethers.parseEther("499"));
      await expect(
        capped.mint(buyer.address, ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(capped, "SupplyCapExceeded");
    });

    it("Should reject zero-amount mint", async function () {
      await expect(
        carbonCredit.mint(buyer.address, 0)
      ).to.be.revertedWithCustomError(carbonCredit, "ZeroMintAmount");
    });

    it("Should track totalMinted and remainingSupply", async function () {
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      expect(await carbonCredit.totalMinted()).to.equal(ethers.parseEther("100"));
      expect(await carbonCredit.remainingSupply()).to.equal(ethers.parseEther("999999900"));
    });

    it("Should emit Minted event", async function () {
      await expect(carbonCredit.mint(buyer.address, ethers.parseEther("50")))
        .to.emit(carbonCredit, "Minted")
        .withArgs(buyer.address, ethers.parseEther("50"), ethers.parseEther("50"), owner.address);
    });
  });

  describe("Energy Trading", function () {
    it("Should allow listing and purchasing energy", async function () {
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      await carbonCredit.connect(buyer).approve(await energyTrading.getAddress(), ethers.parseEther("50"));

      await energyTrading.connect(seller).listEnergy(100, ethers.parseEther("50"));
      expect(await energyTrading.isListingActive(0)).to.equal(true);

      await energyTrading.connect(buyer).purchaseEnergy(0);

      expect(await carbonCredit.balanceOf(seller.address)).to.equal(ethers.parseEther("50"));
      expect(await carbonCredit.balanceOf(buyer.address)).to.equal(ethers.parseEther("50"));
      expect(await energyTrading.isListingActive(0)).to.equal(false);
    });

    it("Should allow sellers to cancel active listings", async function () {
      await energyTrading.connect(seller).listEnergy(50, ethers.parseEther("10"));
      expect(await energyTrading.isListingActive(0)).to.equal(true);

      await expect(energyTrading.connect(seller).cancelListing(0))
        .to.emit(energyTrading, "ListingCancelled")
        .withArgs(0, seller.address);

      expect(await energyTrading.isListingActive(0)).to.equal(false);
    });

    it("Should reject purchases on cancelled listings", async function () {
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      await carbonCredit.connect(buyer).approve(await energyTrading.getAddress(), ethers.parseEther("10"));

      await energyTrading.connect(seller).listEnergy(50, ethers.parseEther("10"));
      await energyTrading.connect(seller).cancelListing(0);

      await expect(
        energyTrading.connect(buyer).purchaseEnergy(0)
      ).to.be.revertedWithCustomError(energyTrading, "ListingNotActive");
    });

    it("Should reject self-purchase", async function () {
      await carbonCredit.mint(seller.address, ethers.parseEther("100"));
      await carbonCredit.connect(seller).approve(await energyTrading.getAddress(), ethers.parseEther("10"));

      await energyTrading.connect(seller).listEnergy(50, ethers.parseEther("10"));

      await expect(
        energyTrading.connect(seller).purchaseEnergy(0)
      ).to.be.revertedWithCustomError(energyTrading, "CannotBuyOwnListing");
    });
  });
});
