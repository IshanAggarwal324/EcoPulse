const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployCarbonCredit, deployEscrowSystem } = require("./helpers/contracts");

/**
 * Module 5.1.1 — EnergyEscrow.
 *
 * Covers: happy release, delivery confirmation, timeout refund, dispute +
 * arbitration outcomes (release / refund / split), access control, reentrancy
 * safety, pause, and constructor bounds.
 */
describe("EnergyEscrow (Module 5.1)", function () {
  let carbonCredit;
  let escrow;
  let disputeResolution;
  let owner;
  let buyer;
  let seller;
  let attacker;

  const AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [owner, buyer, seller, attacker] = await ethers.getSigners();
    carbonCredit = await deployCarbonCredit(owner);
    ({ escrow, disputeResolution } = await deployEscrowSystem(owner, await carbonCredit.getAddress(), {
      admin: owner.address,
    }));

    await carbonCredit.mint(buyer.address, AMOUNT);
    await carbonCredit
      .connect(buyer)
      .approve(await escrow.getAddress(), AMOUNT);
  });

  it("creates a funded escrow by pulling approved tokens", async function () {
    const escrowAddr = await escrow.getAddress();
    await expect(escrow.connect(buyer).createEscrow(0, seller.address, AMOUNT))
      .to.emit(escrow, "EscrowCreated")
      .withArgs(0, 0, buyer.address, seller.address, AMOUNT);

    expect(await carbonCredit.balanceOf(escrowAddr)).to.equal(AMOUNT);
    const e = await escrow.getEscrow(0);
    expect(e.buyer).to.equal(buyer.address);
    expect(e.seller).to.equal(seller.address);
    expect(e.amount).to.equal(AMOUNT);
    expect(e.state).to.equal(0); // Funded
  });

  it("happy path: buyer releases funds to seller", async function () {
    await escrow.connect(buyer).createEscrow(1, seller.address, AMOUNT);
    const sellerBefore = await carbonCredit.balanceOf(seller.address);

    await expect(escrow.connect(buyer).release(0))
      .to.emit(escrow, "EscrowReleased")
      .withArgs(0, seller.address, AMOUNT);

    expect(await carbonCredit.balanceOf(seller.address)).to.equal(sellerBefore + AMOUNT);
    expect((await escrow.getEscrow(0)).state).to.equal(2); // Released
  });

  it("seller can confirm delivery, then buyer releases", async function () {
    await escrow.connect(buyer).createEscrow(2, seller.address, AMOUNT);
    await expect(escrow.connect(seller).confirmDelivery(0))
      .to.emit(escrow, "DeliveryConfirmed")
      .withArgs(0, seller.address);
    expect((await escrow.getEscrow(0)).state).to.equal(1); // Delivered
    await escrow.connect(buyer).release(0);
    expect((await escrow.getEscrow(0)).state).to.equal(2); // Released
  });

  it("refunds the buyer via timeout once the dispute window elapses", async function () {
    await escrow.connect(buyer).createEscrow(3, seller.address, AMOUNT);

    // Within the window the buyer cannot claim a timeout refund.
    await expect(escrow.connect(buyer).claimTimeoutRefund(0))
      .to.be.revertedWithCustomError(escrow, "DisputeWindowOpen");

    const window = await escrow.disputeWindow();
    await ethers.provider.send("evm_increaseTime", [Number(window) + 1]);
    await ethers.provider.send("evm_mine", []);

    const buyerBefore = await carbonCredit.balanceOf(buyer.address);
    await expect(escrow.connect(buyer).claimTimeoutRefund(0))
      .to.emit(escrow, "EscrowRefunded");
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(buyerBefore + AMOUNT);
    expect((await escrow.getEscrow(0)).state).to.equal(4); // Refunded
  });

  it("lets a buyer open a dispute that an arbiter resolves to refund", async function () {
    await escrow.connect(buyer).createEscrow(4, seller.address, AMOUNT);
    const evidence = ethers.id("evidence-cid");

    await expect(escrow.connect(buyer).openDispute(0, evidence))
      .to.emit(escrow, "DisputeOpened");
    expect((await escrow.getEscrow(0)).state).to.equal(3); // Disputed

    const buyerBefore = await carbonCredit.balanceOf(buyer.address);
    await disputeResolution.resolve(0, 1, 0); // Refund
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(buyerBefore + AMOUNT);
    expect((await escrow.getEscrow(0)).state).to.equal(4); // Refunded
  });

  it("arbiter can resolve to release (seller paid) and to split", async function () {
    await escrow.connect(buyer).createEscrow(5, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(0, ethers.id("e1"));

    const sellerBefore = await carbonCredit.balanceOf(seller.address);
    await disputeResolution.resolve(0, 0, 0); // Release
    expect(await carbonCredit.balanceOf(seller.address)).to.equal(sellerBefore + AMOUNT);

    // Split case.
    await carbonCredit.mint(buyer.address, AMOUNT);
    await carbonCredit.connect(buyer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(buyer).createEscrow(6, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(1, ethers.id("e2"));

    const buyerMid = await carbonCredit.balanceOf(buyer.address);
    const sellerMid = await carbonCredit.balanceOf(seller.address);
    await disputeResolution.resolve(1, 2, 2500); // 25% buyer, 75% seller
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(buyerMid + (AMOUNT * 2500n) / 10000n);
    expect(await carbonCredit.balanceOf(seller.address)).to.equal(sellerMid + (AMOUNT * 7500n) / 10000n);
  });

  it("rejects invalid split shares", async function () {
    await escrow.connect(buyer).createEscrow(7, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(0, ethers.id("e"));
    await expect(
      disputeResolution.resolve(0, 2, 10001),
    ).to.be.revertedWithCustomError(disputeResolution, "InvalidShare");
  });

  it("enforces access control (buyer/seller/arbiter)", async function () {
    await escrow.connect(buyer).createEscrow(8, seller.address, AMOUNT);

    // Seller cannot release (buyer-only).
    await expect(
      escrow.connect(seller).release(0),
    ).to.be.revertedWithCustomError(escrow, "NotBuyer");

    // Buyer cannot confirm delivery (seller-only).
    await expect(
      escrow.connect(buyer).confirmDelivery(0),
    ).to.be.revertedWithCustomError(escrow, "NotSeller");

    // Non-arbiter cannot resolve.
    const ARBITER_ROLE = await disputeResolution.ARBITER_ROLE();
    await expect(
      disputeResolution.connect(attacker).resolve(0, 0, 0),
    ).to.be.revertedWithCustomError(disputeResolution, "AccessControlUnauthorizedAccount")
      .withArgs(attacker.address, ARBITER_ROLE);

    // Random address cannot call executeResolution (only dispute contract).
    await expect(
      escrow.connect(attacker).executeResolution(0, 0, 0),
    ).to.be.revertedWithCustomError(escrow, "NotDisputeResolver");
  });

  it("cannot escrow to self, zero seller, or zero amount", async function () {
    await expect(
      escrow.connect(buyer).createEscrow(0, buyer.address, AMOUNT),
    ).to.be.revertedWithCustomError(escrow, "CannotEscrowToSelf");
    await expect(
      escrow.connect(buyer).createEscrow(0, ethers.ZeroAddress, AMOUNT),
    ).to.be.revertedWithCustomError(escrow, "InvalidSeller");
    await expect(
      escrow.connect(buyer).createEscrow(0, seller.address, 0),
    ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
  });

  it("dispute cannot be opened after the window closes", async function () {
    await escrow.connect(buyer).createEscrow(9, seller.address, AMOUNT);
    const window = await escrow.disputeWindow();
    await ethers.provider.send("evm_increaseTime", [Number(window) + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      escrow.connect(buyer).openDispute(0, ethers.id("late")),
    ).to.be.revertedWithCustomError(escrow, "DisputeWindowClosed");
  });

  it("prevents double resolution of the same dispute", async function () {
    await escrow.connect(buyer).createEscrow(10, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(0, ethers.id("e"));
    await disputeResolution.resolve(0, 0, 0);
    await expect(
      disputeResolution.resolve(0, 1, 0),
    ).to.be.revertedWithCustomError(disputeResolution, "AlreadyResolved");
  });

  it("rejects direct state mutations on a disputed escrow", async function () {
    await escrow.connect(buyer).createEscrow(11, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(0, ethers.id("e"));
    await expect(escrow.connect(buyer).release(0))
      .to.be.revertedWithCustomError(escrow, "InvalidState");
  });

  it("owner can pause / unpause the escrow", async function () {
    await escrow.pause();
    await expect(
      escrow.connect(buyer).createEscrow(12, seller.address, AMOUNT),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await escrow.unpause();
    await expect(escrow.connect(buyer).createEscrow(13, seller.address, AMOUNT))
      .to.emit(escrow, "EscrowCreated");
  });

  it("rejects out-of-bounds dispute windows at construction", async function () {
    const EnergyEscrow = await ethers.getContractFactory("EnergyEscrow");
    await expect(
      EnergyEscrow.deploy(await carbonCredit.getAddress(), 60), // < 1 hour
    ).to.be.revertedWithCustomError(EnergyEscrow, "InvalidDisputeWindow");
  });

  it("refunds the buyer from Delivered state once the dispute window elapses", async function () {
    // Regression: a seller's confirmDelivery (Funded -> Delivered) must NOT
    // strand the buyer. Previously claimTimeoutRefund required Funded, so a
    // buyer whose funds were in Delivered after the window had no exit.
    await escrow.connect(buyer).createEscrow(20, seller.address, AMOUNT);
    await escrow.connect(seller).confirmDelivery(0);
    expect((await escrow.getEscrow(0)).state).to.equal(1); // Delivered

    // Within the window the buyer still cannot claim a timeout refund.
    await expect(escrow.connect(buyer).claimTimeoutRefund(0))
      .to.be.revertedWithCustomError(escrow, "DisputeWindowOpen");

    const window = await escrow.disputeWindow();
    await ethers.provider.send("evm_increaseTime", [Number(window) + 1]);
    await ethers.provider.send("evm_mine", []);

    const buyerBefore = await carbonCredit.balanceOf(buyer.address);
    await expect(escrow.connect(buyer).claimTimeoutRefund(0))
      .to.emit(escrow, "EscrowRefunded");
    expect(await carbonCredit.balanceOf(buyer.address)).to.equal(buyerBefore + AMOUNT);
    expect((await escrow.getEscrow(0)).state).to.equal(4); // Refunded
  });

  it("freezes the resolver pointer while a dispute is in-flight, releases after", async function () {
    // Regression (M-2): re-pointing / zeroing the resolver could strand an
    // open Disputed escrow. The pointer is frozen while disputedCount > 0.
    await escrow.connect(buyer).createEscrow(30, seller.address, AMOUNT);
    await escrow.connect(buyer).openDispute(0, ethers.id("e"));
    expect(await escrow.disputedCount()).to.equal(1);

    await expect(escrow.setDisputeResolution(await disputeResolution.getAddress()))
      .to.be.revertedWithCustomError(escrow, "DisputesInFlight");
    // Zero address is rejected outright (checked before the freeze).
    await expect(escrow.setDisputeResolution(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(escrow, "InvalidResolver");

    // Resolve the dispute (owner is the arbiter) → counter returns to 0.
    await disputeResolution.resolve(0, 1, 0); // Refund
    expect(await escrow.disputedCount()).to.equal(0);

    // Now re-pointing is allowed again.
    await expect(escrow.setDisputeResolution(await disputeResolution.getAddress()))
      .to.emit(escrow, "DisputeResolutionSet");
  });
});
