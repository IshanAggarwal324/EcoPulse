const { expect } = require("chai");
const { ethers } = require("hardhat");
const { execFileSync } = require("child_process");
const path = require("path");
const { deployCarbonCredit } = require("./helpers/contracts");

describe("Audit readiness & mint governance (C8 / C9)", function () {
  it("exposes UNAUDITED on-chain status marker", async function () {
    const [admin] = await ethers.getSigners();
    const carbonCredit = await deployCarbonCredit(admin);
    expect(await carbonCredit.AUDIT_STATUS()).to.equal("UNAUDITED");
  });

  it("rejects uncapped deployment (maxSupply = 0)", async function () {
    const [admin] = await ethers.getSigners();
    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    await expect(
      CarbonCredit.deploy(0, ethers.parseEther("1000"), admin.address),
    ).to.be.revertedWithCustomError(CarbonCredit, "ZeroMaxSupply");
  });

  it("rejects zero maxMintPerTx", async function () {
    const [admin] = await ethers.getSigners();
    const CarbonCredit = await ethers.getContractFactory("CarbonCredit");
    await expect(
      CarbonCredit.deploy(ethers.parseEther("1000"), 0, admin.address),
    ).to.be.revertedWithCustomError(CarbonCredit, "ZeroMaxMintPerTx");
  });

  it("enforces per-transaction mint cap", async function () {
    const [admin, recipient] = await ethers.getSigners();
    const carbonCredit = await deployCarbonCredit(admin, {
      maxMintPerTx: ethers.parseEther("100"),
    });

    await expect(
      carbonCredit.mint(recipient.address, ethers.parseEther("101")),
    ).to.be.revertedWithCustomError(carbonCredit, "MintAmountExceedsLimit");
  });

  it("allows only MINTER_ROLE to mint", async function () {
    const [admin, minter, recipient, outsider] = await ethers.getSigners();
    const carbonCredit = await deployCarbonCredit(admin, {
      grantMinterTo: minter.address,
      revokeDeployerMinter: true,
    });

    await expect(
      carbonCredit.connect(outsider).mint(recipient.address, ethers.parseEther("1")),
    ).to.be.reverted;

    await carbonCredit.connect(minter).mint(recipient.address, ethers.parseEther("1"));
    expect(await carbonCredit.balanceOf(recipient.address)).to.equal(ethers.parseEther("1"));
  });

  it("admin can grant and revoke minter role", async function () {
    const [admin, ops, recipient] = await ethers.getSigners();
    const carbonCredit = await deployCarbonCredit(admin, {
      revokeDeployerMinter: true,
    });

    await carbonCredit.grantMinter(ops.address);
    await carbonCredit.connect(ops).mint(recipient.address, ethers.parseEther("5"));

    await carbonCredit.revokeMinter(ops.address);
    await expect(
      carbonCredit.connect(ops).mint(recipient.address, ethers.parseEther("1")),
    ).to.be.reverted;
  });

  it("predeploy-check blocks mainnet without audit ack", function () {
    const script = path.join(__dirname, "..", "scripts", "predeploy-check.js");
    expect(() => {
      execFileSync(process.execPath, [script, "--mainnet"], {
        env: { ...process.env, MAINNET_AUDIT_ACK: "" },
        stdio: "pipe",
      });
    }).to.throw();
  });

  it("predeploy-check passes for testnet intent", function () {
    const script = path.join(__dirname, "..", "scripts", "predeploy-check.js");
    const output = execFileSync(process.execPath, [script], {
      env: { ...process.env, HARDHAT_NETWORK: "sepolia" },
      encoding: "utf8",
    });
    expect(output).to.include("Pre-deploy checks passed");
  });
});
