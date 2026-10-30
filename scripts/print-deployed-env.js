#!/usr/bin/env node
/**
 * Prints the environment variables to update after a contract deployment.
 *
 *   node scripts/print-deployed-env.js                       # chain-11155111 (default Ignition id)
 *   node scripts/print-deployed-env.js sepolia-v2            # a custom --deployment-id
 *   node scripts/print-deployed-env.js sepolia-v2 11155111   # explicit chain id
 *
 * Reads ignition/deployments/<id>/deployed_addresses.json (written by
 * `npx hardhat ignition deploy ...`). It only prints PUBLIC contract addresses and
 * a block number: no keys or secrets.
 */
const fs = require('fs');
const path = require('path');

const deploymentId = process.argv[2] || 'chain-11155111';
const chainId = process.argv[3] || (deploymentId.match(/^chain-(\d+)$/) || [])[1] || '11155111';
const dir = path.join(__dirname, '..', 'ignition', 'deployments', deploymentId);

// Contract (Ignition future id) -> [backend variable, frontend variable]
const MAP = [
  ['CarbonCredit', 'CARBON_CREDIT_ADDRESS', 'VITE_CARBON_CREDIT_ADDRESS'],
  ['EnergyTrading', 'ENERGY_TRADING_ADDRESS', 'VITE_ENERGY_TRADING_ADDRESS'],
  ['EnergyEscrow', 'ENERGY_ESCROW_ADDRESS', 'VITE_ENERGY_ESCROW_ADDRESS'],
  ['DisputeResolution', 'DISPUTE_RESOLUTION_ADDRESS', 'VITE_DISPUTE_RESOLUTION_ADDRESS'],
  ['RetirementRegistry', 'RETIREMENT_REGISTRY_ADDRESS', null],
  ['CarbonCreditBridge', 'CARBON_CREDIT_BRIDGE_ADDRESS', 'VITE_CARBON_CREDIT_BRIDGE_ADDRESS'],
];

const fail = (message) => {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

if (!fs.existsSync(path.join(dir, 'deployed_addresses.json'))) {
  fail(`No deployment found at ${path.relative(process.cwd(), dir)}\\deployed_addresses.json. Deploy first.`);
}

const addresses = readJson(path.join(dir, 'deployed_addresses.json'));
const find = (name) => {
  const key = Object.keys(addresses).find((k) => k.endsWith(`#${name}`));
  return key ? addresses[key] : null;
};

// Earliest block among this deployment's confirmed transactions, so the indexer
// can start exactly there instead of relying on a short lookback window.
const firstBlock = () => {
  const journal = path.join(dir, 'journal.jsonl');
  if (!fs.existsSync(journal)) return null;
  let min = null;
  for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const block = Number(entry?.receipt?.blockNumber);
      if (Number.isFinite(block) && block > 0 && (min === null || block < min)) min = block;
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return min;
};

const missing = MAP.filter(([name]) => !find(name)).map(([name]) => name);
const startBlock = firstBlock();

console.log(`Deployment: ${deploymentId}   Chain id: ${chainId}\n`);

console.log('=== Render: backend service (Environment) ===');
for (const [name, backendVar] of MAP) {
  const addr = find(name);
  if (addr) console.log(`${backendVar}=${addr}`);
}
if (startBlock) {
  console.log(`BLOCKCHAIN_SYNC_FROM_BLOCK=${startBlock}   # first block of this deployment; index from here`);
} else {
  console.log('# BLOCKCHAIN_SYNC_FROM_BLOCK: deployment block not found in the journal; set it manually');
}

console.log('\n=== Vercel: frontend project (Environment Variables, then REDEPLOY: VITE_* is baked in at build) ===');
for (const [name, , frontendVar] of MAP) {
  const addr = find(name);
  if (addr && frontendVar) console.log(`${frontendVar}=${addr}`);
}
console.log(`VITE_CHAIN_ID=${chainId}`);

if (missing.length) {
  console.log(`\nNOTE: not present in this deployment: ${missing.join(', ')}`);
}
console.log(
  '\nAfter updating: redeploy the backend and the frontend, then run `node scripts/verify-deployment.js`' +
    ' (checks the contracts on-chain match what the backend expects).',
);
