const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const Retirement = require('../models/Retirement');
const auditService = require('./auditService');
const { parsePagination, paginateResults } = require('../utils/paginate');
const { logger, logBackgroundError } = require('../utils/logger');

const normalizeAddr = (addr) => (addr ? String(addr).toLowerCase() : null);

const RETIRED_TOPIC = (() => {
  try {
    return BlockchainService.getCarbonCreditContractReadOnly().interface.getEvent('Retired').topicHash;
  } catch {
    // ABI/artifact not loaded yet (e.g. address unset) — compute from the fragment.
    return ethers.id('Retired(address,uint256,uint256,string,address)');
  }
})();

/**
 * Parse a transaction receipt and persist every CarbonCredit `Retired` log it
 * contains. Idempotent on (chainId, contractAddress, retirementId).
 */
async function indexRetirementTx(txHash, { actor } = {}) {
  const provider = BlockchainService.getProvider();
  const carbonAddress = process.env.CARBON_CREDIT_ADDRESS;
  if (!provider || !carbonAddress) {
    throw new Error('Carbon credit provider/address not configured');
  }

  const receipt = await provider.getTransactionReceipt(normalizeAddr(txHash));
  if (!receipt) {
    const err = new Error('Transaction receipt not found');
    err.statusCode = 404;
    throw err;
  }
  if (receipt.status !== 1) {
    const err = new Error('Transaction reverted on chain');
    err.statusCode = 422;
    throw err;
  }

  const ccInterface = BlockchainService.getCarbonCreditContractReadOnly().interface;
  const target = normalizeAddr(carbonAddress);
  let chainId = Number(receipt.chainId);
  if (!Number.isFinite(chainId)) {
    const network = await provider.getNetwork();
    chainId = Number(network.chainId);
  }

  let blockTimestamp = null;
  if (receipt.blockNumber != null) {
    try {
      const block = await provider.getBlock(receipt.blockNumber);
      blockTimestamp = block?.timestamp ? block.timestamp * 1000 : null;
    } catch (e) {
      logBackgroundError(e, { component: 'retirementService', stage: 'getBlock' });
    }
  }

  const records = [];
  for (const log of receipt.logs) {
    if (normalizeAddr(log.address) !== target) continue;
    if (log.topics?.[0] !== RETIRED_TOPIC) continue;

    const parsed = ccInterface.parseLog({ topics: log.topics, data: log.data });
    const getArg = (key, index) =>
      parsed.args?.[key] !== undefined ? parsed.args[key] : parsed.args?.[index];
    const retirementId = Number(getArg('retirementId', 2));
    const amount = getArg('amount', 1);

    const record = await upsertRetirement({
      chainId,
      contractAddress: target,
      retirementId,
      retiree: String(getArg('account', 0)).toLowerCase(),
      amount: amount.toString(),
      amountEther: ethers.formatEther(amount),
      certificateUri: String(getArg('certificateUri', 3) ?? ''),
      initiator: String(getArg('initiator', 4) ?? getArg('account', 0)).toLowerCase(),
      txHash: normalizeAddr(txHash),
      blockNumber: receipt.blockNumber,
      blockTimestamp,
    });
    if (record) records.push(record);
  }

  if (records.length && actor) {
    try {
      await auditService.log({
        action: 'carbon.retirement_indexed',
        resourceType: 'trade',
        resourceId: normalizeAddr(txHash),
        actorId: actor.id || null,
        actorEmail: actor.email || null,
        actorRole: actor.role || null,
        severity: 'info',
        metadata: { count: records.length, retirementIds: records.map((r) => r.retirementId) },
      });
    } catch (e) {
      logBackgroundError(e, { component: 'retirementService', stage: 'audit' });
    }
  }

  return records;
}

async function upsertRetirement(payload) {
  const {
    chainId,
    contractAddress,
    retirementId,
    retiree,
    amount,
    amountEther,
    certificateUri,
    initiator,
    txHash,
    blockNumber,
    blockTimestamp,
  } = payload;

  return Retirement.findOneAndUpdate(
    { chainId, contractAddress: normalizeAddr(contractAddress), retirementId },
    {
      $set: {
        retiree: normalizeAddr(retiree),
        amount: String(amount),
        amountEther,
        certificateUri,
        initiator: normalizeAddr(initiator),
        txHash: normalizeAddr(txHash),
        blockNumber: blockNumber != null ? Number(blockNumber) : null,
        blockTimestamp: blockTimestamp != null ? new Date(blockTimestamp) : null,
        contractAddress: normalizeAddr(contractAddress),
      },
    },
    { upsert: true, new: true },
  );
}

async function getRetirements({ wallet, page, limit }) {
  const query = {};
  if (wallet) query.retiree = normalizeAddr(wallet);
  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });
  const [data, total] = await Promise.all([
    Retirement.find(query).sort({ retirementId: -1 }).skip(skip).limit(l).lean(),
    Retirement.countDocuments(query),
  ]);
  return { data, meta: paginateResults({ page: p, limit: l, total }) };
}

async function getRetirement(retirementId) {
  return Retirement.findOne({ retirementId: Number(retirementId) }).lean();
}

/**
 * Best-effort platform totals from the chain. Returns nulls when the token is
 * not configured so the UI degrades gracefully.
 */
async function getTotals() {
  try {
    const cc = BlockchainService.getCarbonCreditContractReadOnly();
    const [totalSupply, totalMinted, totalRetired, totalRetirements] = await Promise.all([
      cc.totalSupply(),
      cc.totalMinted(),
      cc.totalRetired(),
      cc.totalRetirements(),
    ]);
    return {
      totalSupply: ethers.formatEther(totalSupply),
      totalMinted: ethers.formatEther(totalMinted),
      totalRetired: ethers.formatEther(totalRetired),
      totalRetirements: Number(totalRetirements),
    };
  } catch (e) {
    logBackgroundError(e, { component: 'retirementService', stage: 'getTotals' });
    return { totalSupply: null, totalMinted: null, totalRetired: null, totalRetirements: null };
  }
}

module.exports = {
  indexRetirementTx,
  upsertRetirement,
  getRetirements,
  getRetirement,
  getTotals,
};
