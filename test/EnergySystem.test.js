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
      // Setup balances
      await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
      
      // Buyer needs to approve EnergyTrading to spend their CarbonCredits
      await carbonCredit.connect(buyer).approve(await energyTrading.getAddress(), ethers.parseEther("50"));

      // Seller lists energy
      await energyTrading.connect(seller).listEnergy(100, ethers.parseEther("50"));

      // Buyer purchases energy
      await energyTrading.connect(buyer).purchaseEnergy(0);

      // Verify seller received payment
      expect(await carbonCredit.balanceOf(seller.address)).to.equal(ethers.parseEther("50"));
      
      // Verify buyer spent payment
      expect(await carbonCredit.balanceOf(buyer.address)).to.equal(ethers.parseEther("50"));
    });
  });
});
