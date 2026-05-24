const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("EnergySystemModule", (m) => {
  const carbonCredit = m.contract("CarbonCredit");

  const energyTrading = m.contract("EnergyTrading", [carbonCredit]);

  return { carbonCredit, energyTrading };
});
