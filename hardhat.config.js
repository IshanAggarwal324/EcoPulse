require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const MAINNET_NETWORK_NAMES = new Set(["mainnet", "ethereum", "homestead"]);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    sepolia: {
      url: process.env.ALCHEMY_SEPOLIA_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // Mainnet is intentionally omitted. Add only after audit + predeploy-check pass.
  },
};

// Fail fast if a mainnet network is injected via env without explicit audit ack (C8).
for (const [name, config] of Object.entries(module.exports.networks)) {
  const isMainnet =
    MAINNET_NETWORK_NAMES.has(String(name).toLowerCase()) || config?.chainId === 1;
  if (isMainnet && process.env.MAINNET_AUDIT_ACK !== "confirmed") {
    throw new Error(
      `Network "${name}" is blocked until MAINNET_AUDIT_ACK=confirmed (see contracts/AUDIT_MANIFEST.json)`,
    );
  }
}
