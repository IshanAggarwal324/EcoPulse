const { ethers } = require('ethers');
const BlockchainService = require('./blockchainService');
const Settlement = require('../models/Settlement');
const Trade = require('../models/Trade');
const auditService = require('./auditService');
const { WALLET_REGEX } = require('../utils/validators');
const { logBackgroundError, logger } = require('../utils/logger');

/**
 * Settlement Verification Service — Module 5.2.2
 *
 * verifyPurchase(txHash, expectedListingId) decodes the on-chain purchase
 * receipt and asserts the buyer / seller / amount / price match the listing
 * struct still readable from the EnergyTrading contract. Returns a structured
 * VerificationResult that the API and reconciliation layers consume.
 *
 * Security guardrails (production):
 *  - Strict txHash + listingId input validation before any RPC call.
 *  - The decoded EnergyPurchased log MUST originate from the configured
 *    EnergyTrading contract address (prevents spoofing via a look-alike
 *    contract on the same chain).
 *  - Confirmation depth enforced so a reorg cannot flip a verification.
 *  - Reverted transactions are rejected outright.
 *  - Every input the caller controls is normalized to a canonical form before
 *    being compared or persisted (lowercase addresses / txHashes).
 */

const TX_HASH_REGEX = /^0x[a-f0-9]{64}$/i;

const getRequiredConfirmations = () => {
  const parsed = parseInt(process.env.SETTLEMENT_MIN_CONFIRMATIONS || '12', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 12;
};

class VerificationError extends Error {
  constructor(message, code = 'VERIFICATION_FAILED') {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * Validate caller-supplied inputs up front so we never issue an RPC call for
 * malformed/adversarial input (guards against log-injection via crafted hashes
 * and avoids burning provider budget on nonsense).
 */
const validateInputs = (txHash, expectedListingId) => {
  const hash = String(txHash || '').trim().toLowerCase();
  if (!TX_HASH_REGEX.test(hash)) {
    throw new VerificationError('txHash must be a 32-byte hex transaction hash', 'INVALID_TX_HASH');
  }

  // Reject before coercion: Number(null) === 0 would otherwise silently validate.
  if (expectedListingId === null || expectedListingId === undefined || typeof expectedListingId === 'boolean') {
    throw new VerificationError('expectedListingId must be a non-negative integer', 'INVALID_LISTING_ID');
  }
  const id = Number(expectedListingId);
  if (!Number.isInteger(id) || id < 0 || id > 2 ** 32 - 1) {
    throw new VerificationError('expectedListingId must be a non-negative integer', 'INVALID_LISTING_ID');
  }

  return { hash, id };
};

const addrEq = (a, b) =>
  String(a || '').toLowerCase() === String(b || '').toLowerCase();

const normalizeAddr = (a) => (a ? String(a).toLowerCase() : null);

/**
 * Decode the receipt of a purchase transaction and assert the EnergyPurchased
 * event matches the on-chain listing struct.
 *
 * @returns {Promise<object>} structured VerificationResult
 */
async function verifyPurchase(txHash, expectedListingId) {
  const { hash, id: listingId } = validateInputs(txHash, expectedListingId);

  const contract = BlockchainService.getEnergyTradingContractReadOnly();
  const provider = contract.runner?.provider;
  if (!provider) {
    throw new VerificationError('Blockchain provider unavailable', 'PROVIDER_UNAVAILABLE');
  }

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const expectedContract = String(process.env.ENERGY_TRADING_ADDRESS).toLowerCase();

  // Fetch the receipt. A missing/null receipt is treated as an explicit failure
  // (not a thrown error) so callers can surface a deterministic result.
  const receipt = await provider.getTransactionReceipt(hash).catch((err) => {
    throw new VerificationError(`Failed to fetch receipt: ${err.message}`, 'RECEIPT_FETCH_FAILED');
  });

  const result = {
    verified: false,
    txHash: hash,
    chainId,
    contractAddress: expectedContract,
    listingId,
    confirmations: null,
    blockNumber: receipt?.blockNumber ?? null,
    buyer: null,
    seller: null,
    energyAmount: null,
    price: null,
    mismatches: [],
    error: null,
  };

  if (!receipt) {
    result.error = 'Transaction receipt not found';
    return result;
  }

  if (receipt.status === 0) {
    result.error = 'Transaction reverted on-chain';
    result.mismatches.push('REVERTED_TX');
    return result;
  }

  // Confirmation depth — never trust a settlement that a reorg could invalidate.
  const latest = await provider.getBlockNumber().catch(() => null);
  if (latest != null) {
    result.confirmations = Math.max(0, latest - receipt.blockNumber);
    const required = getRequiredConfirmations();
    if (result.confirmations < required) {
      result.error = `Insufficient confirmations (${result.confirmations}/${required})`;
      return result;
    }
  }

  // Decode logs using the EnergyTrading ABI, but only trust an EnergyPurchased
  // log emitted by the configured contract address. An attacker controlling a
  // different contract could otherwise emit a matching event to spoof a trade.
  let purchaseLog = null;
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== expectedContract) continue;
    let parsed;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name === 'EnergyPurchased') {
      purchaseLog = { log, parsed };
      break;
    }
  }

  if (!purchaseLog) {
    result.error = 'No EnergyPurchased event in this transaction';
    return result;
  }

  const args = purchaseLog.parsed.args;
  const getArg = (key, index) =>
    args?.[key] !== undefined ? args[key] : args?.[index];

  const eventListingId = Number(getArg('listingId', 0));
  const buyer = normalizeAddr(getArg('buyer', 1));
  const seller = normalizeAddr(getArg('seller', 2));
  const energyAmount = Number(getArg('energyAmount', 3));
  const price = ethers.formatEther(getArg('price', 4));

  result.listingId = eventListingId;
  result.buyer = buyer;
  result.seller = seller;
  result.energyAmount = energyAmount;
  result.price = price;

  // Cross-check against the authoritative on-chain listing struct. The event
  // args are the source of truth for the *fill*, but `listings(id)` confirms
  // the seller identity and that the listing actually exists for this trade.
  let listing = null;
  try {
    listing = await contract.listings(eventListingId);
  } catch (err) {
    result.mismatches.push('LISTING_READ_FAILED');
    result.error = `Could not read on-chain listing: ${err.message}`;
    return result;
  }

  const onChainSeller = normalizeAddr(listing.seller ?? listing[0]);
  if (!onChainSeller || onChainSeller === ethers.ZeroAddress) {
    result.mismatches.push('LISTING_NOT_FOUND');
    return result;
  }

  if (listingId !== eventListingId) {
    result.mismatches.push('LISTING_ID_MISMATCH');
  }

  if (!addrEq(seller, onChainSeller)) {
    result.mismatches.push('SELLER_MISMATCH');
  }

  // Sanity: buyer must not equal seller (the contract forbids self-purchase).
  if (addrEq(buyer, seller)) {
    result.mismatches.push('BUYER_EQUALS_SELLER');
  }

  // Wallet shape validation on the recovered parties (defence-in-depth).
  if (!WALLET_REGEX.test(buyer) || !WALLET_REGEX.test(seller)) {
    result.mismatches.push('MALFORMED_ADDRESS');
  }

  result.verified = result.mismatches.length === 0;
  return result;
}

/**
 * Persist a VerificationResult into a Settlement record (upsert by the unique
 * chain/contract/tx/logIndex key). Also links the originating Trade row when
 * one exists in the index.
 */
async function persistVerification(result, { actor = null, req = null } = {}) {
  const filter = {
    chainId: result.chainId,
    contractAddress: result.contractAddress,
    txHash: result.txHash,
    logIndex: result.logIndex ?? 0,
  };

  const onChainEnergy = Number.isFinite(result.energyAmount)
    ? Number(result.energyAmount)
    : null;

  const update = {
    listingId: result.listingId,
    buyer: result.buyer,
    seller: result.seller,
    onChainEnergy,
    onChainPrice: result.price ?? null,
    onChainStatus: result.verified ? 'sold' : result.error ? 'unknown' : 'sold',
    confirmations: result.confirmations ?? null,
    blockNumber: result.blockNumber ?? null,
    evidence: {
      ...(result.evidence || {}),
      receipt: {
        mismatches: result.mismatches,
        error: result.error,
        verifiedAt: new Date().toISOString(),
      },
    },
  };

  // Only flip verificationStatus when verification actually resolved (verified
  // or an explicit receipt mismatch). Pending confirmations / missing receipt
  // leave the prior status untouched so reconciliation can retry.
  const receiptMismatch = result.error === 'Transaction reverted on-chain'
    || result.mismatches.some((m) => m !== 'REVERTED_TX');
  if (result.verified) {
    update.verificationStatus = 'verified';
    update.verifiedAt = new Date();
  } else if (receiptMismatch) {
    update.verificationStatus = 'mismatch';
    update.$addToSet = { mismatchFlags: 'RECEIPT_MISMATCH' };
  }

  // Best-effort link to the indexed Trade row.
  try {
    const trade = await Trade.findOne({
      txHash: result.txHash,
      eventType: 'purchased',
    })
      .sort({ logIndex: 1 })
      .lean();
    if (trade) {
      filter.logIndex = trade.logIndex;
      update.tradeRef = trade._id;
      update.logIndex = trade.logIndex;
    }
  } catch (err) {
    logBackgroundError('settlementVerification.linkTrade', err, { txHash: result.txHash });
  }

  const settlement = await Settlement.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
  });

  if (result.seller && update.verificationStatus) {
    try {
      const { recomputeReputation } = require('./reputationService');
      recomputeReputation(result.seller).catch((e) =>
        logBackgroundError('settlementVerification.reputationRefresh', e, {
          seller: result.seller,
          txHash: result.txHash,
        }),
      );
    } catch (e) {
      logBackgroundError('settlementVerification.reputationRefresh', e, {
        seller: result.seller,
        txHash: result.txHash,
      });
    }
  }

  auditService
    .log({
      actor: actor || { _id: null, email: null, role: null },
      action: result.verified ? 'SETTLEMENT_VERIFIED' : 'SETTLEMENT_VERIFICATION_FAILED',
      resourceType: 'trade',
      resourceId: result.txHash,
      metadata: {
        listingId: result.listingId,
        verified: result.verified,
        mismatches: result.mismatches,
        error: result.error,
        confirmations: result.confirmations,
        chainId: result.chainId,
      },
      req,
      severity: result.verified ? 'info' : 'warn',
    })
    .catch((e) => logBackgroundError('settlementVerification.audit', e));

  logger.info('settlement verified', {
    txHash: result.txHash,
    listingId: result.listingId,
    verified: result.verified,
    component: 'settlement-verification',
  });

  return settlement;
}

module.exports = {
  verifyPurchase,
  persistVerification,
  validateInputs,
  VerificationError,
  getRequiredConfirmations,
};
