const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Energy System", function () {
  let carbonCredit;
  let energyTrading;
  let owner;
  let seller;
  let buyer;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();

    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    carbonCredit = await CarbonCredit.deploy();
    await carbonCredit.waitForDeployment();

    const EnergyTrading = await ethers.getContractFactory("EnergyTrading");
    energyTrading = await EnergyTrading.deploy(await carbonCredit.getAddress());
    await energyTrading.waitForDeployment();
  });

  describe("Carbon Credit", function () {
    it("Should mint tokens correctly", async function () {
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      expect(await carbonCredit.balanceOf(buyer.address)).to.equal(ethers.parseEther("100"));
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
