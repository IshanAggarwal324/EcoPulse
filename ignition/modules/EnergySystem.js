const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("EnergySystemModule", (m) => {
  // Max supply: 1 billion CC tokens (with 18 decimals). Must be > 0 (uncapped forbidden).
  const MAX_SUPPLY = m.getParameter("maxSupply", "1000000000000000000000000000");
  // Per-transaction mint cap: 1 million CC (operational rate limit — C9).
  const MAX_MINT_PER_TX = m.getParameter("maxMintPerTx", "1000000000000000000000000");
  // Admin receives DEFAULT_ADMIN_ROLE + initial MINTER_ROLE — transfer to multisig post-deploy.
  const ADMIN = m.getParameter("admin", m.getAccount(0));

  const carbonCredit = m.contract("CarbonCredit", [MAX_SUPPLY, MAX_MINT_PER_TX, ADMIN]);

  const energyTrading = m.contract("EnergyTrading", [carbonCredit]);

  return { carbonCredit, energyTrading };
});
