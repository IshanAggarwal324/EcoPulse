#!/usr/bin/env node
/**
 * Verifies that the contracts at the configured addresses match the ABI the
 * backend uses. Run it after a (re)deployment, and any time you see
 * "could not decode result data" warnings in the backend logs.
 *
 *   ENERGY_TRADING_ADDRESS=0x... RPC_URL=https://... node scripts/verify-deployment.js
 *
 * Variables (same names as the backend): RPC_URL (defaults to a public Sepolia
 * node), ENERGY_TRADING_ADDRESS, CARBON_CREDIT_ADDRESS (optional). Read-only:
 * it only makes eth_call / eth_getCode requests.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env'), quiet: true });
const { ethers } = require('ethers');
const abi = require('../backend/constants/energyTradingAbi');

const rpcUrl = process.env.VERIFY_RPC_URL || process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const tradingAddress = process.env.ENERGY_TRADING_ADDRESS;

const results = [];
const check = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  if (!tradingAddress) {
    console.error('ENERGY_TRADING_ADDRESS is not set.');
    process.exit(2);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const network = await provider.getNetwork();
  console.log(`Network chain id ${network.chainId}, contract ${tradingAddress}\n`);

  const code = await provider.getCode(tradingAddress);
  check(code && code !== '0x', 'contract code exists at ENERGY_TRADING_ADDRESS');
  if (!code || code === '0x') process.exit(1);

  const contract = new ethers.Contract(tradingAddress, abi, provider);
  const iface = new ethers.Interface(abi);

  // Every function the backend can call must exist in the deployed bytecode.
  const bytecode = code.toLowerCase();
  const missing = [];
  iface.forEachFunction((fn) => {
    if (!bytecode.includes(`63${fn.selector.slice(2)}`)) missing.push(fn.format('sighash'));
  });
  check(missing.length === 0, 'deployed contract has every function the backend ABI uses', missing.join(', '));

  try {
    const next = Number(await contract.nextListingId());
    check(true, 'nextListingId() works', `${next} listings created so far`);
    if (next > 0) {
      const listing = await contract.listings(next - 1);
      check(true, 'listings(id) decodes with the backend ABI', `expiresAt=${listing.expiresAt}`);
    } else {
      // No listing to decode yet: compare the declared return arity with a raw call.
      const raw = await provider.call({ to: tradingAddress, data: iface.encodeFunctionData('listings', [0]) });
      const words = (raw.length - 2) / 64;
      check(words === 6, 'listings(id) returns the 6 fields the backend expects', `${words} words`);
    }
  } catch (err) {
    check(false, 'listings(id) decodes with the backend ABI', err.code || err.shortMessage || err.message);
  }

  try {
    await contract.paused();
    check(true, 'paused() works');
  } catch (err) {
    check(false, 'paused() works', err.code || err.shortMessage);
  }

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} check(s) FAILED: the deployed contract does not match the backend.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('Verification could not run:', err.message);
  process.exit(2);
});
