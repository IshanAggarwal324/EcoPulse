const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("EnergySystemModule", (m) => {
  // Max supply: 1 billion CC tokens (with 18 decimals)
  const MAX_SUPPLY = m.getParameter("maxSupply", "1000000000000000000000000000");

  const carbonCredit = m.contract("CarbonCredit", [MAX_SUPPLY]);

  const energyTrading = m.contract("EnergyTrading", [carbonCredit]);

  return { carbonCredit, energyTrading };
});
