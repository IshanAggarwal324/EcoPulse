#!/usr/bin/env node
/**
 * Pre-deploy gate for EcoPulse smart contracts (C8).
 *
 * Blocks mainnet deployment until a professional audit is recorded in
 * contracts/AUDIT_MANIFEST.json and MAINNET_AUDIT_ACK=confirmed is set.
 *
 * Usage:
 *   node scripts/predeploy-check.js                  # testnet / local — informational
 *   node scripts/predeploy-check.js --mainnet        # strict mainnet gate
 *   HARDHAT_NETWORK=mainnet node scripts/predeploy-check.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'contracts', 'AUDIT_MANIFEST.json');

const MAINNET_CHAIN_IDS = new Set(['1', '8453', '137', '42161', '10']);
const MAINNET_NETWORK_NAMES = new Set(['mainnet', 'ethereum', 'homestead']);

const isMainnetIntent = () =>
  process.argv.includes('--mainnet')
  || MAINNET_NETWORK_NAMES.has(String(process.env.HARDHAT_NETWORK || '').toLowerCase())
  || MAINNET_CHAIN_IDS.has(String(process.env.CHAIN_ID || ''));

const loadManifest = () => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing audit manifest: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
};

const run = () => {
  const manifest = loadManifest();
  const mainnet = isMainnetIntent();

  console.log(`Audit manifest status: ${manifest.status}`);
  console.log(`Target network: ${process.env.HARDHAT_NETWORK || (mainnet ? 'mainnet (explicit)' : 'local/testnet')}`);

  if (manifest.status !== 'audited') {
    console.warn(
      'WARNING: Contracts are NOT formally audited. Safe for testnet/local development only.',
    );
  }

  if (!mainnet) {
    console.log('Pre-deploy checks passed for non-mainnet deployment.');
    return;
  }

  if (process.env.MAINNET_AUDIT_ACK !== 'confirmed') {
    console.error('\nBLOCKED: Mainnet deployment requires MAINNET_AUDIT_ACK=confirmed');
    console.error('See contracts/AUDIT_MANIFEST.json and contracts/SECURITY.md');
    process.exit(1);
  }

  if (manifest.status !== 'audited') {
    console.error('\nBLOCKED: AUDIT_MANIFEST.json status must be "audited" before mainnet deploy');
    console.error(`Current status: ${manifest.status}`);
    process.exit(1);
  }

  if (!manifest.auditor || !manifest.reportUrl) {
    console.error('\nBLOCKED: auditor and reportUrl must be set in AUDIT_MANIFEST.json');
    process.exit(1);
  }

  console.log(`Audit report: ${manifest.reportUrl}`);
  console.log('Pre-deploy checks passed for MAINNET deployment.');
};

try {
  run();
} catch (err) {
  console.error('Pre-deploy check failed:', err.message);
  process.exit(1);
}
