const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployCarbonCredit, deployBridge } = require("./helpers/contracts");

/**
 * Module 5.3.3 — CarbonCreditBridge.
 *
 * Covers: lock (custody + caps), mintFor (relayer gating + nonce idempotency),
 * returnToSource (burn), releaseBack (custody release + idempotency), pause,
 * supported-chain / same-chain guards, and access control.
 *
 * NOTE: hardhat default chain id is 31337; outbound/inbound chains use other ids.
 */
describe("CarbonCreditBridge (Module 5.3.3)", function () {
  let carbonCredit;
  let bridge;
  let admin; // holds DEFAULT_ADMIN_ROLE + RELAYER_ROLE
  let sender;
  let recipient;
  let attacker;

  const TARGET = 999;
  const SRC = 1;
  const AMOUNT = ethers.parseEther("500");

  beforeEach(async function () {
    [admin, sender, recipient, attacker] = await ethers.getSigners();
    carbonCredit = await deployCarbonCredit(admin);
    bridge = await deployBridge(admin, await carbonCredit.getAddress(), { admin: admin.address });
    await bridge.setSupportedChain(TARGET, true);
    await carbonCredit.mint(sender.address, ethers.parseEther("1000000"));
  });

  it("lock takes custody and emits Locked", async function () {
    await carbonCredit.connect(sender).approve(await bridge.getAddress(), AMOUNT);
    await expect(bridge.connect(sender).lock(AMOUNT, TARGET, recipient.address))
      .to.emit(bridge, "Locked")
      .withArgs(0, sender.address, recipient.address, AMOUNT, TARGET);

    expect(await bridge.getBridgeBalance()).to.equal(AMOUNT);
    expect(await bridge.totalLockedIn()).to.equal(AMOUNT);
    expect(await bridge.nextLockId()).to.equal(1);
  });

  it("lock rejects unsupported chains, same-chain, zero amounts, and zero recipient", async function () {
    await carbonCredit.connect(sender).approve(await bridge.getAddress(), AMOUNT);

    await expect(bridge.connect(sender).lock(AMOUNT, 888, recipient.address))
      .to.be.revertedWithCustomError(bridge, "UnsupportedChain");
    await expect(bridge.connect(sender).lock(AMOUNT, 31337, recipient.address))
      .to.be.revertedWithCustomError(bridge, "SameChainBridge");
    await expect(bridge.connect(sender).lock(0, TARGET, recipient.address))
      .to.be.revertedWithCustomError(bridge, "ZeroAmount");
    await expect(bridge.connect(sender).lock(AMOUNT, TARGET, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(bridge, "ZeroAddress");
  });

  it("lock enforces the per-tx cap", async function () {
    const over = ethers.parseEther("200000"); // > default 100k cap
    await carbonCredit.connect(sender).approve(await bridge.getAddress(), over);
    await expect(bridge.connect(sender).lock(over, TARGET, recipient.address))
      .to.be.revertedWithCustomError(bridge, "ExceedsPerTxCap");
  });

  it("mintFor credits tokens (relayer only) and is idempotent on the nonce", async function () {
    await expect(bridge.connect(admin).mintFor(recipient.address, AMOUNT, SRC, 1))
      .to.emit(bridge, "Minted")
      .withArgs(1, recipient.address, AMOUNT, SRC, admin.address);
    expect(await carbonCredit.balanceOf(recipient.address)).to.equal(AMOUNT);

    // Replaying the same nonce must fail — the core anti-double-mint guard.
    await expect(bridge.connect(admin).mintFor(recipient.address, AMOUNT, SRC, 1))
      .to.be.revertedWithCustomError(bridge, "NonceAlreadyProcessed");

    // A different nonce succeeds.
    await expect(bridge.connect(admin).mintFor(recipient.address, AMOUNT, SRC, 2))
      .to.emit(bridge, "Minted");
    expect(await carbonCredit.balanceOf(recipient.address)).to.equal(AMOUNT * 2n);
  });

  it("non-relayers cannot mint", async function () {
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();
    await expect(bridge.connect(attacker).mintFor(recipient.address, AMOUNT, SRC, 1))
      .to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount")
      .withArgs(attacker.address, RELAYER_ROLE);
  });

  it("mintFor rejects zero recipient and same-chain source", async function () {
    await expect(bridge.connect(admin).mintFor(ethers.ZeroAddress, AMOUNT, SRC, 1))
      .to.be.revertedWithCustomError(bridge, "ZeroAddress");
    await expect(bridge.connect(admin).mintFor(recipient.address, AMOUNT, 31337, 1))
      .to.be.revertedWithCustomError(bridge, "SameChainBridge");
  });

  it("full return cycle: returnToSource burns, releaseBack returns custody (idempotent)", async function () {
    // Fund custody so releaseBack has tokens to return.
    await carbonCredit.connect(sender).approve(await bridge.getAddress(), AMOUNT);
    await bridge.connect(sender).lock(AMOUNT, TARGET, recipient.address);
    expect(await bridge.getBridgeBalance()).to.equal(AMOUNT);

    // Holder burns bridged tokens to trigger a return on the source chain.
    await carbonCredit.connect(recipient).approve(await bridge.getAddress(), AMOUNT);
    await carbonCredit.connect(admin).mint(recipient.address, AMOUNT); // give recipient bridged tokens
    await expect(bridge.connect(recipient).returnToSource(AMOUNT, SRC))
      .to.emit(bridge, "ReturnedToSource")
      .withArgs(0, recipient.address, AMOUNT, SRC);
    expect(await carbonCredit.balanceOf(recipient.address)).to.equal(0);
    expect(await bridge.nextReturnId()).to.equal(1);

    // Relayer releases originally locked custody back.
    const balBefore = await carbonCredit.balanceOf(recipient.address);
    await expect(bridge.connect(admin).releaseBack(recipient.address, AMOUNT, SRC, 0))
      .to.emit(bridge, "Released")
      .withArgs(0, recipient.address, AMOUNT, SRC, admin.address);
    expect(await carbonCredit.balanceOf(recipient.address)).to.equal(balBefore + AMOUNT);
    expect(await bridge.getBridgeBalance()).to.equal(0);

    // Replaying the release fails.
    await expect(bridge.connect(admin).releaseBack(recipient.address, AMOUNT, SRC, 0))
      .to.be.revertedWithCustomError(bridge, "NonceAlreadyProcessed");
  });

  it("daily cap bounds the rolling 24h outbound volume", async function () {
    const smallBridge = await deployBridge(admin, await carbonCredit.getAddress(), {
      admin: admin.address,
      maxPerTx: ethers.parseEther("100"),
      dailyCap: ethers.parseEther("150"),
    });
    await smallBridge.setSupportedChain(TARGET, true);
    await carbonCredit.connect(sender).approve(await smallBridge.getAddress(), ethers.parseEther("300"));

    await smallBridge.connect(sender).lock(ethers.parseEther("100"), TARGET, recipient.address);
    expect(await smallBridge.dailyRemaining()).to.equal(ethers.parseEther("50"));

    await expect(
      smallBridge.connect(sender).lock(ethers.parseEther("100"), TARGET, recipient.address),
    ).to.be.revertedWithCustomError(smallBridge, "ExceedsDailyCap");
  });

  it("pause blocks all movement; unpause restores it", async function () {
    await carbonCredit.connect(sender).approve(await bridge.getAddress(), AMOUNT);
    await bridge.pause();

    await expect(bridge.connect(sender).lock(AMOUNT, TARGET, recipient.address))
      .to.be.revertedWithCustomError(bridge, "EnforcedPause");
    await expect(bridge.connect(admin).mintFor(recipient.address, AMOUNT, SRC, 1))
      .to.be.revertedWithCustomError(bridge, "EnforcedPause");

    await bridge.unpause();
    await expect(bridge.connect(sender).lock(AMOUNT, TARGET, recipient.address))
      .to.emit(bridge, "Locked");
  });

  it("constructor rejects invalid cap configuration", async function () {
    const CarbonCreditBridge = await ethers.getContractFactory("CarbonCreditBridge");
    await expect(
      CarbonCreditBridge.deploy(await carbonCredit.getAddress(), ethers.parseEther("100"), ethers.parseEther("50"), admin.address),
    ).to.be.revertedWithCustomError(CarbonCreditBridge, "DailyCapConfigTooSmall");
    await expect(
      CarbonCreditBridge.deploy(await carbonCredit.getAddress(), 0, ethers.parseEther("50"), admin.address),
    ).to.be.revertedWithCustomError(CarbonCreditBridge, "ZeroLimit");
  });
});
