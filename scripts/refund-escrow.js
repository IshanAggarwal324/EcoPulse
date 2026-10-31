#!/usr/bin/env node
/**
 * Gets locked escrow funds back to the buyer on Sepolia (test use).
 *
 * How: the buyer opens a dispute on each escrow (allowed while the dispute window
 * is open), then an arbiter resolves it with outcome "Refund", and the escrow
 * contract sends the CC back to the buyer. This only works when the signing wallet
 * is BOTH the escrow's buyer AND holds ARBITER_ROLE (true for the sepolia-v2 deployer).
 *
 *   node scripts/refund-escrow.js <escrowId> [escrowId ...]            (dry run)
 *   node scripts/refund-escrow.js <escrowId> [escrowId ...] --send     (sends transactions)
 *
 * Example: node scripts/refund-escrow.js 0 1 --send
 *
 * Needs PRIVATE_KEY (and optionally ALCHEMY_SEPOLIA_URL) in the repo-root .env, the
 * same file scripts/mint-cc.js uses. The key is read from the environment and never printed.
 * Optional overrides: ENERGY_ESCROW_ADDRESS, DISPUTE_RESOLUTION_ADDRESS, CARBON_CREDIT_ADDRESS.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { ethers } = require('ethers');

const SEPOLIA_CHAIN_ID = 11155111n;
const ESCROW = process.env.ENERGY_ESCROW_ADDRESS || '0xA0993932AF92cB0BD0930964D45bfc620fE2AF5A';
const DISPUTE = process.env.DISPUTE_RESOLUTION_ADDRESS || '0xe8211a09C05be9c42cb785F868fd66227D3398E2';
const TOKEN = process.env.CARBON_CREDIT_ADDRESS || '0x6393380E22Ab40dA9265299667969176ad3D47A7';

const STATES = ['funded', 'delivered', 'released', 'disputed', 'refunded'];
const OUTCOME_REFUND = 1; // enum Outcome { Release, Refund, Split }

const escrowAbi = [
  'function getEscrow(uint256) view returns (address buyer, address seller, uint256 amount, uint8 state, uint256 createdAt, uint256 deliveredAt)',
  'function disputeWindow() view returns (uint256)',
  'function openDispute(uint256 escrowId, bytes32 evidenceHash)',
];
const disputeAbi = [
  'function ARBITER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function resolve(uint256 disputeId, uint8 outcome, uint256 buyerShareBps)',
  'event DisputeOpened(uint256 indexed disputeId, uint256 indexed escrowId, address indexed buyer, address seller, uint256 amount, bytes32 evidenceHash)',
  'function disputeCount() view returns (uint256)',
  'function disputes(uint256) view returns (uint256 escrowId, address buyer, address seller, uint256 amount, bytes32 evidenceHash, bool resolved, uint8 outcome, uint256 createdAt)',
];
const tokenAbi = ['function balanceOf(address) view returns (uint256)'];

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

(async () => {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const ids = args.filter((a) => a !== '--send');
  if (ids.length === 0 || ids.some((a) => !/^\d+$/.test(a))) {
    fail('Usage: node scripts/refund-escrow.js <escrowId> [escrowId ...] [--send]');
  }
  const escrowIds = [...new Set(ids.map((a) => BigInt(a)))];

  if (!process.env.PRIVATE_KEY) fail('PRIVATE_KEY is not set in the repo-root .env');
  const rpcUrl = process.env.ALCHEMY_SEPOLIA_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) fail(`Connected to chain ${network.chainId}, expected Sepolia`);

  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const escrow = new ethers.Contract(ESCROW, escrowAbi, signer);
  const dispute = new ethers.Contract(DISPUTE, disputeAbi, signer);
  const token = new ethers.Contract(TOKEN, tokenAbi, provider);

  const isArbiter = await dispute.hasRole(await dispute.ARBITER_ROLE(), signer.address);
  const windowSec = Number(await escrow.disputeWindow());
  const now = (await provider.getBlock('latest')).timestamp;
  const ethBalance = await provider.getBalance(signer.address);

  console.log(`Signing wallet:  ${signer.address}`);
  console.log(`Has ARBITER_ROLE: ${isArbiter}`);
  console.log(`Sepolia ETH:     ${ethers.formatEther(ethBalance)}`);
  console.log(`CC balance now:  ${ethers.formatEther(await token.balanceOf(signer.address))}\n`);

  // Finds the unresolved dispute that belongs to an escrow (null if none).
  const findOpenDispute = async (escrowId) => {
    const count = Number(await dispute.disputeCount());
    for (let i = count - 1; i >= 0; i -= 1) {
      const d = await dispute.disputes(i);
      if (d.escrowId === escrowId && !d.resolved) return BigInt(i);
    }
    return null;
  };

  const todo = [];
  let problems = 0;
  for (const id of escrowIds) {
    let e;
    try {
      e = await escrow.getEscrow(id);
    } catch {
      console.log(`Escrow ${id}: not found`);
      problems += 1;
      continue;
    }
    const state = STATES[Number(e.state)] ?? 'unknown';
    const windowOpen = now <= Number(e.createdAt) + windowSec;
    const isBuyer = e.buyer.toLowerCase() === signer.address.toLowerCase();

    // Resume: an escrow already in "disputed" only needs the arbiter's ruling.
    if (state === 'disputed') {
      const pending = await findOpenDispute(id);
      console.log(
        `Escrow ${id}: ${ethers.formatEther(e.amount)} CC, state=disputed, open dispute #${pending ?? 'none'} -> ${pending !== null ? 'OK to resolve (Refund)' : 'SKIP'}`,
      );
      if (pending !== null) todo.push({ id, disputeId: pending });
      else problems += 1;
      continue;
    }

    const ok = (state === 'funded' || state === 'delivered') && windowOpen && isBuyer;
    console.log(
      `Escrow ${id}: ${ethers.formatEther(e.amount)} CC, state=${state}, window open=${windowOpen}, signer is buyer=${isBuyer} -> ${ok ? 'OK to refund' : 'SKIP'}`,
    );
    if (ok) todo.push({ id, disputeId: null });
    else problems += 1;
  }

  if (!isArbiter) fail('The signing wallet does not have ARBITER_ROLE, so it cannot resolve the dispute.');
  if (ethBalance === 0n) fail('No Sepolia ETH for gas.');
  if (todo.length === 0) fail('Nothing to refund.');
  if (problems > 0) console.log(`\n${problems} escrow(s) skipped.`);

  if (!send) {
    console.log(`\nDry run only. Would open + resolve (Refund) ${todo.length} escrow(s). Add --send to do it.`);
    return;
  }

  for (const { id, disputeId: existing } of todo) {
    let disputeId = existing;
    if (disputeId === null) {
      console.log(`\nEscrow ${id}: opening dispute...`);
      const tx1 = await escrow.openDispute(id, ethers.id(`test-refund-escrow-${id}`));
      await tx1.wait();
      // Read the id back from the contract (more reliable than decoding the log).
      disputeId = await findOpenDispute(id);
      if (disputeId === null) fail(`Dispute opened (tx ${tx1.hash}) but no open dispute was found. Stop and check Etherscan.`);
      console.log(`Escrow ${id}: dispute #${disputeId} opened (tx ${tx1.hash}).`);
    } else {
      console.log(`\nEscrow ${id}: dispute #${disputeId} already open.`);
    }
    console.log(`Escrow ${id}: resolving with Refund...`);
    const tx2 = await dispute.resolve(disputeId, OUTCOME_REFUND, 0);
    await tx2.wait();
    const after = await escrow.getEscrow(id);
    console.log(`Escrow ${id}: state=${STATES[Number(after.state)]} (tx ${tx2.hash})`);
  }

  console.log(`\nCC balance now:  ${ethers.formatEther(await token.balanceOf(signer.address))}`);
})().catch((err) => {
  console.error(`ERROR: ${err.shortMessage || err.message}`);
  process.exit(1);
});
