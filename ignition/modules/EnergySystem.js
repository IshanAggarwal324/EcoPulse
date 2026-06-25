const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("EnergySystemModule", (m) => {
  // Max supply: 1 billion CC tokens (with 18 decimals). Must be > 0 (uncapped forbidden).
  const MAX_SUPPLY = m.getParameter("maxSupply", "1000000000000000000000000000");
  // Per-transaction mint cap: 1 million CC (operational rate limit — C9).
  const MAX_MINT_PER_TX = m.getParameter("maxMintPerTx", "1000000000000000000000000");
  // Admin receives DEFAULT_ADMIN_ROLE + initial MINTER_ROLE — transfer to multisig post-deploy.
  const ADMIN = m.getParameter("admin", m.getAccount(0));
  // Module 5.1 — escrow dispute window (seconds). Bounds enforced on-chain [1h, 30d].
  const DISPUTE_WINDOW = m.getParameter("disputeWindow", "259200"); // 3 days

  // Module 5.3 — carbon lifecycle (retirement registry + bridge). Opt out by
  // setting enableCarbonLifecycle=false for a minimal (legacy) deployment.
  const ENABLE_CARBON_LIFECYCLE = m.getParameter("enableCarbonLifecycle", true);
  // Bridge throughput caps (raw, 18 decimals). 100k CC per tx, 1M CC / 24h.
  const BRIDGE_MAX_PER_TX = m.getParameter("bridgeMaxPerTx", "100000000000000000000000");
  const BRIDGE_DAILY_CAP = m.getParameter("bridgeDailyCap", "1000000000000000000000000");

  const carbonCredit = m.contract("CarbonCredit", [MAX_SUPPLY, MAX_MINT_PER_TX, ADMIN]);

  const energyTrading = m.contract("EnergyTrading", [carbonCredit]);

  // Escrow system: deploy escrow, then dispute resolution (needs escrow addr),
  // then link the dispute contract back into the escrow.
  const energyEscrow = m.contract("EnergyEscrow", [carbonCredit, DISPUTE_WINDOW]);

  const disputeResolution = m.contract("DisputeResolution", [energyEscrow, ADMIN]);

  m.call(energyEscrow, "setDisputeResolution", [disputeResolution], { after: [disputeResolution] });

  // Module 5.3.2 — retirement registry, linked back into the token.
  let retirementRegistry = null;
  let carbonCreditBridge = null;
  if (ENABLE_CARBON_LIFECYCLE) {
    retirementRegistry = m.contract("RetirementRegistry", [carbonCredit, ADMIN]);
    m.call(carbonCredit, "setRetirementRegistry", [retirementRegistry], {
      after: [retirementRegistry],
    });

    // Module 5.3.3 — bridge. Granted MINTER_ROLE so inbound mintFor() works.
    carbonCreditBridge = m.contract("CarbonCreditBridge", [
      carbonCredit,
      BRIDGE_MAX_PER_TX,
      BRIDGE_DAILY_CAP,
      ADMIN,
    ]);
    m.call(carbonCredit, "grantMinter", [carbonCreditBridge], {
      after: [carbonCreditBridge],
    });
  }

  return { carbonCredit, energyTrading, energyEscrow, disputeResolution, retirementRegistry, carbonCreditBridge };
});
