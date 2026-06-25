const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployCarbonCredit, deployRetirementRegistry } = require("./helpers/contracts");

/**
 * Module 5.3.1 + 5.3.2 — CarbonCredit burn/retire + RetirementRegistry.
 *
 * Covers: burn, burnFrom (allowance), retire/retireFrom (counters + event +
 * registry record), attestation, bounds, access control, supply accounting.
 */
describe("Carbon retirement (Module 5.3.1 / 5.3.2)", function () {
  let carbonCredit;
  let registry;
  let admin;
  let holder;
  let spender;
  let attacker;

  const AMOUNT = ethers.parseEther("1000");
  const URI = "ipfs://bafy certificate";

  beforeEach(async function () {
    [admin, holder, spender, attacker] = await ethers.getSigners();
    carbonCredit = await deployCarbonCredit(admin);
    registry = await deployRetirementRegistry(admin, await carbonCredit.getAddress(), {
      admin: admin.address,
    });

    await carbonCredit.mint(holder.address, AMOUNT);
  });

  it("burn reduces balance + totalSupply but leaves totalMinted unchanged", async function () {
    const supplyBefore = await carbonCredit.totalSupply();
    await expect(carbonCredit.connect(holder).burn(AMOUNT / 2n))
      .to.emit(carbonCredit, "Burned")
      .withArgs(holder.address, AMOUNT / 2n, holder.address);

    expect(await carbonCredit.balanceOf(holder.address)).to.equal(AMOUNT / 2n);
    expect(await carbonCredit.totalSupply()).to.equal(supplyBefore - AMOUNT / 2n);
    expect(await carbonCredit.totalMinted()).to.equal(AMOUNT); // cumulative unchanged
  });

  it("burnFrom consumes allowance and burns on behalf", async function () {
    await carbonCredit.connect(holder).approve(spender.address, AMOUNT / 2n);
    await expect(carbonCredit.connect(spender).burnFrom(holder.address, AMOUNT / 2n))
      .to.emit(carbonCredit, "Burned")
      .withArgs(holder.address, AMOUNT / 2n, spender.address);

    expect(await carbonCredit.balanceOf(holder.address)).to.equal(AMOUNT / 2n);
    expect(await carbonCredit.allowance(holder.address, spender.address)).to.equal(0);
  });

  it("burnFrom reverts when allowance is insufficient", async function () {
    await carbonCredit.connect(holder).approve(spender.address, AMOUNT / 4n);
    await expect(
      carbonCredit.connect(spender).burnFrom(holder.address, AMOUNT / 2n),
    ).to.be.revertedWithCustomError(carbonCredit, "ERC20InsufficientAllowance");
  });

  it("retire burns, increments counters, emits Retired, and records on the registry", async function () {
    const supplyBefore = await carbonCredit.totalSupply();
    await expect(carbonCredit.connect(holder).retire(AMOUNT, URI))
      .to.emit(carbonCredit, "Retired")
      .withArgs(holder.address, AMOUNT, 0, URI, holder.address)
      .and.to.emit(registry, "Recorded")
      .withArgs(0, holder.address, AMOUNT, holder.address, URI);

    expect(await carbonCredit.balanceOf(holder.address)).to.equal(0);
    expect(await carbonCredit.totalSupply()).to.equal(supplyBefore - AMOUNT);
    expect(await carbonCredit.totalRetired()).to.equal(AMOUNT);
    expect(await carbonCredit.totalRetirements()).to.equal(1);
    expect(await carbonCredit.retiredByAccount(holder.address)).to.equal(AMOUNT);

    const r = await registry.getRetirement(0);
    expect(r.retiree).to.equal(holder.address);
    expect(r.amount).to.equal(AMOUNT);
    expect(r.certificateUri).to.equal(URI);
    expect(r.attested).to.equal(false);
  });

  it("retireFrom consumes allowance and credits the account (not the caller)", async function () {
    await carbonCredit.connect(holder).approve(spender.address, AMOUNT);
    await expect(carbonCredit.connect(spender).retireFrom(holder.address, AMOUNT, URI))
      .to.emit(carbonCredit, "Retired")
      .withArgs(holder.address, AMOUNT, 0, URI, spender.address);

    expect(await carbonCredit.allowance(holder.address, spender.address)).to.equal(0);
    expect(await carbonCredit.retiredByAccount(holder.address)).to.equal(AMOUNT);
    const r = await registry.getRetirement(0);
    expect(r.initiator).to.equal(spender.address);
  });

  it("retirement ids are monotonic across accounts", async function () {
    await carbonCredit.mint(attacker.address, AMOUNT);
    await carbonCredit.connect(holder).retire(AMOUNT / 2n, URI);
    await carbonCredit.connect(attacker).retire(AMOUNT / 2n, URI);

    expect(await carbonCredit.totalRetirements()).to.equal(2);
    expect(await registry.retirementCount()).to.equal(2);
    expect((await registry.getRetirement(1)).retiree).to.equal(attacker.address);
  });

  it("attester can attach provenance once; double-attest reverts", async function () {
    await carbonCredit.connect(holder).retire(AMOUNT, URI);
    const nodeHash = ethers.id("node-7:salt");
    await expect(registry.attest(0, "Solar farm A", 2024, nodeHash))
      .to.emit(registry, "Attested")
      .withArgs(0, admin.address, "Solar farm A", 2024, nodeHash);

    const r = await registry.getRetirement(0);
    expect(r.attested).to.equal(true);
    expect(r.project).to.equal("Solar farm A");
    expect(r.nodeHash).to.equal(nodeHash);

    await expect(registry.attest(0, "x", 2024, nodeHash))
      .to.be.revertedWithCustomError(registry, "AlreadyAttested");
  });

  it("rejects zero amount and over-long certificate URIs", async function () {
    await expect(carbonCredit.connect(holder).retire(0, URI))
      .to.be.revertedWithCustomError(carbonCredit, "ZeroBurnAmount");

    const tooLong = "x".repeat(257);
    await expect(carbonCredit.connect(holder).retire(1, tooLong))
      .to.be.revertedWithCustomError(carbonCredit, "CertificateUriTooLong");
  });

  it("cannot retire more than the balance", async function () {
    await expect(
      carbonCredit.connect(holder).retire(AMOUNT + 1n, URI),
    ).to.be.revertedWithCustomError(carbonCredit, "ERC20InsufficientBalance");
  });

  it("retire still works (event + burn) when no registry is linked", async function () {
    await carbonCredit.setRetirementRegistry(ethers.ZeroAddress);
    await expect(carbonCredit.connect(holder).retire(AMOUNT, URI))
      .to.emit(carbonCredit, "Retired")
      .and.to.not.emit(registry, "Recorded");
    expect(await carbonCredit.totalRetired()).to.equal(AMOUNT);
  });

  it("enforces access control on registry and link management", async function () {
    // Only the token may record.
    await expect(
      registry.connect(attacker).record(holder.address, 1, 5, URI, attacker.address),
    ).to.be.revertedWithCustomError(registry, "NotToken");

    // Only an attester may attest.
    const ATTESTER_ROLE = await registry.ATTESTER_ROLE();
    await carbonCredit.connect(holder).retire(AMOUNT, URI);
    await expect(registry.connect(attacker).attest(0, "p", 2024, ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(attacker.address, ATTESTER_ROLE);

    // Only admin may re-link the registry.
    const DEFAULT_ADMIN_ROLE = await carbonCredit.DEFAULT_ADMIN_ROLE();
    await expect(
      carbonCredit.connect(attacker).setRetirementRegistry(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(carbonCredit, "AccessControlUnauthorizedAccount")
      .withArgs(attacker.address, DEFAULT_ADMIN_ROLE);
  });
});
