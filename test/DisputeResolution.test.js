const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployCarbonCredit, deployEscrowSystem } = require("./helpers/contracts");

/**
 * Module 5.1.2 — DisputeResolution contract-level tests: role management,
 * event emission, and that openDispute is callable only by the escrow.
 */
describe("DisputeResolution (Module 5.1)", function () {
  let carbonCredit;
  let escrow;
  let disputeResolution;
  let owner;
  let admin;
  let arbiter;
  let buyer;
  let seller;
  let other;

  beforeEach(async function () {
    [owner, admin, arbiter, buyer, seller, other] = await ethers.getSigners();
    carbonCredit = await deployCarbonCredit(owner);
    ({ escrow, disputeResolution } = await deployEscrowSystem(owner, await carbonCredit.getAddress(), {
      admin: admin.address,
    }));

    await carbonCredit.mint(buyer.address, ethers.parseEther("100"));
    await carbonCredit.connect(buyer).approve(await escrow.getAddress(), ethers.parseEther("100"));
  });

  it("grants admin + arbiter roles to the configured admin", async function () {
    const ARBITER_ROLE = await disputeResolution.ARBITER_ROLE();
    const DEFAULT_ADMIN_ROLE = await disputeResolution.DEFAULT_ADMIN_ROLE();
    expect(await disputeResolution.hasRole(ARBITER_ROLE, admin.address)).to.equal(true);
    expect(await disputeResolution.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
  });

  it("admin can grant and revoke arbiter role", async function () {
    const ARBITER_ROLE = await disputeResolution.ARBITER_ROLE();
    await disputeResolution.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);
    expect(await disputeResolution.hasRole(ARBITER_ROLE, arbiter.address)).to.equal(true);

    await disputeResolution.connect(admin).revokeRole(ARBITER_ROLE, arbiter.address);
    expect(await disputeResolution.hasRole(ARBITER_ROLE, arbiter.address)).to.equal(false);
  });

  it("only the escrow can open a dispute record", async function () {
    await expect(
      disputeResolution
        .connect(other)
        .openDispute(0, buyer.address, seller.address, 100n, ethers.id("e")),
    ).to.be.revertedWithCustomError(disputeResolution, "NotEscrow");
  });

  it("emits DisputeOpened when a buyer disputes via the escrow", async function () {
    await escrow.connect(buyer).createEscrow(0, seller.address, ethers.parseEther("100"));
    const evidence = ethers.id("evidence");
    await expect(escrow.connect(buyer).openDispute(0, evidence))
      .to.emit(disputeResolution, "DisputeOpened")
      .withArgs(0, 0, buyer.address, seller.address, ethers.parseEther("100"), evidence);
  });

  it("reverts when resolving a non-existent dispute", async function () {
    await expect(
      disputeResolution.connect(admin).resolve(99, 0, 0),
    ).to.be.revertedWithCustomError(disputeResolution, "DisputeNotFound");
  });
});
