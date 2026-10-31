#!/usr/bin/env node
/**
 * Mints test Carbon Credit (CC) tokens on Sepolia to one or more wallets so you
 * can test trading / blockchain flows.
 *
 *   node scripts/mint-cc.js <amountCC> <wallet1> [wallet2 ...]            (dry run)
 *   node scripts/mint-cc.js <amountCC> <wallet1> [wallet2 ...] --send     (sends transactions)
 *
 * Example: node scripts/mint-cc.js 100 0xAAA... 0xBBB... --send
 *
 * Needs, in the repo-root .env (the same file Hardhat uses; never commit it):
 *   PRIVATE_KEY           the wallet that holds MINTER_ROLE (the sepolia-v2 deployer)
 *   ALCHEMY_SEPOLIA_URL   optional; a public Sepolia RPC is used when unset
 * Optional: CARBON_CREDIT_ADDRESS (defaults to the sepolia-v2 token).
 *
 * The signing wallet needs a little Sepolia ETH for gas. The private key is
 * read from the environment only and is never printed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { ethers } = require('ethers');

const SEPOLIA_CHAIN_ID = 11155111n;
const DEFAULT_TOKEN = '0x6393380E22Ab40dA9265299667969176ad3D47A7'; // sepolia-v2 CarbonCredit
const MAX_MINT_PER_TX_CC = 1_000_000n;

const ABI = [
  'function mint(address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
];

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

(async () => {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const [amountArg, ...wallets] = args.filter((a) => a !== '--send');

  if (!amountArg || wallets.length === 0) {
    fail('Usage: node scripts/mint-cc.js <amountCC> <wallet1> [wallet2 ...] [--send]');
  }
  if (!/^\d+(\.\d+)?$/.test(amountArg) || Number(amountArg) <= 0) fail(`Invalid amount: ${amountArg}`);
  for (const w of wallets) {
    if (!ethers.isAddress(w)) fail(`Not a valid wallet address: ${w}`);
  }
  const unique = [...new Set(wallets.map((w) => ethers.getAddress(w)))];

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) fail('PRIVATE_KEY is not set in the repo-root .env');

  const rpcUrl = process.env.ALCHEMY_SEPOLIA_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const network = await provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) fail(`Connected to chain ${network.chainId}, expected Sepolia (11155111)`);

  const signer = new ethers.Wallet(privateKey, provider);
  const tokenAddress = process.env.CARBON_CREDIT_ADDRESS || DEFAULT_TOKEN;
  const token = new ethers.Contract(tokenAddress, ABI, signer);

  const decimals = Number(await token.decimals());
  const amount = ethers.parseUnits(amountArg, decimals);
  if (amount > ethers.parseUnits(MAX_MINT_PER_TX_CC.toString(), decimals)) {
    fail(`Amount exceeds the per-transaction mint limit of ${MAX_MINT_PER_TX_CC} CC`);
  }

  const minterRole = await token.MINTER_ROLE();
  const isMinter = await token.hasRole(minterRole, signer.address);
  const ethBalance = await provider.getBalance(signer.address);

  console.log(`Token:          ${tokenAddress}`);
  console.log(`Signing wallet: ${signer.address}`);
  console.log(`Has MINTER_ROLE: ${isMinter}`);
  console.log(`Sepolia ETH:    ${ethers.formatEther(ethBalance)}`);
  console.log(`Plan: mint ${amountArg} CC to each of ${unique.length} wallet(s)\n`);

  if (!isMinter) fail('The signing wallet does not have MINTER_ROLE on this token. Use the wallet that deployed it.');
  if (ethBalance === 0n) fail('The signing wallet has no Sepolia ETH for gas.');

  if (!send) {
    console.log('Dry run only. Nothing was sent. Add --send to mint.');
    return;
  }

  for (const to of unique) {
    const before = await token.balanceOf(to);
    const tx = await token.mint(to, amount);
    console.log(`${to}: tx ${tx.hash} sent, waiting...`);
    await tx.wait();
    const after = await token.balanceOf(to);
    console.log(
      `${to}: balance ${ethers.formatUnits(before, decimals)} -> ${ethers.formatUnits(after, decimals)} CC`,
    );
  }
  console.log('\nDone. In MetaMask, import the token (address above) on Sepolia to see the balance.');
})().catch((err) => {
  console.error(`ERROR: ${err.shortMessage || err.message}`);
  process.exit(1);
});
