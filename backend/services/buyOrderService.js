/**
 * Buy-order service (Sub-module 6.1.3 — buy-side order book, off-chain).
 *
 * Builds + verifies the EIP-712 off-chain buy intent the user signs in
 * MetaMask to declare demand (max energy + max unit price + max total). The
 * backend NEVER holds a private key — it only:
 *   1. rebuilds the canonical typed-data from the *declared* bounds,
 *   2. recovers the signer from the signature,
 *   3. asserts the recovered signer equals the user's walletAddress,
 *   4. enforces per-user monotonic nonces (replay protection),
 *   5. enforces future expiry + positive, self-consistent bounds,
 *   6. persists the signature + bounds + nonce (nothing secret).
 *
 * Security model mirrors listingIntentService: the client cannot forge
 * authority. A signature over bounds B fails verification against the canonical
 * rebuild of A; a signature for wallet X on account Y is rejected; a captured
 * signature is useless once consumed/cancelled or past expiry; a stale nonce is
 * rejected. Bidder privacy: the public depth ladder aggregates demand by price
 * level only — per-wallet buy orders are returned only to their owner.
 */

const { ethers } = require('ethers');
const BuyOrder = require('../models/BuyOrder');
const config = require('../config/autoTrading');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Bounds caps — prevent a single intent from poisoning the aggregated book or
// acting as an unbounded storage vector. Tuned generously for real energy lots.
const MAX_ENERGY_KWH = Number(process.env.BUY_ORDER_MAX_ENERGY_KWH || 1_000_000);
const MAX_UNIT_PRICE_CC = Number(process.env.BUY_ORDER_MAX_UNIT_PRICE_CC || 1_000_000);
const MAX_TOTAL_CC = Number(process.env.BUY_ORDER_MAX_TOTAL_CC || 1_000_000_000);
// How far into the future an intent may be valid (caps stale open-ended bids).
const MAX_TTL_SECONDS = Number(process.env.BUY_ORDER_MAX_TTL_SECONDS || 30 * 24 * 60 * 60);

/**
 * Canonical EIP-712 type schema. Signer (frontend) and verifier (here) MUST use
 * this exact schema. Exposed via the domain endpoint so the frontend never
 * hardcodes it.
 */
const BUY_ORDER_TYPES = {
  BuyOrder: [
    { name: 'maxEnergyKwh', type: 'uint256' },
    { name: 'maxUnitPriceMicroCc', type: 'uint256' },
    { name: 'maxTotalCc', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const toUint = (value) => {
  const n = Math.max(0, Math.floor(Number(value)));
  if (!Number.isFinite(n)) return 0n;
  return BigInt(n);
};

const toMicroCcUint = (cc) => {
  if (cc === null || cc === undefined) return 0n;
  const micro = Math.round(Number(cc) * Number(config.MICRO_CC_SCALE));
  return BigInt(Math.max(0, micro));
};

const microCcToCc = (micro) => {
  const n = Number(micro) / Number(config.MICRO_CC_SCALE);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build the canonical EIP-712 typed-data for a buy order.
 *
 * @param {object} opts
 * @param {number} opts.maxEnergyKwh
 * @param {number} opts.maxUnitPriceCc
 * @param {number} opts.maxTotalCc
 * @param {number} opts.expiresAtUnix  unix seconds
 * @param {number} opts.nonce
 * @returns {{types, primaryType, domain, message}} typed-data with bigint uints
 */
function buildTypedData({ maxEnergyKwh, maxUnitPriceCc, maxTotalCc, expiresAtUnix, nonce }) {
  const domain = {
    name: config.EIP712_DOMAIN_NAME,
    version: config.EIP712_DOMAIN_VERSION,
    chainId: config.getChainId(),
    verifyingContract: config.getEnergyTradingAddress(),
  };

  const message = {
    maxEnergyKwh: toUint(maxEnergyKwh),
    maxUnitPriceMicroCc: toMicroCcUint(maxUnitPriceCc),
    maxTotalCc: toUint(maxTotalCc),
    expiresAt: toUint(expiresAtUnix),
    nonce: toUint(nonce),
  };

  return {
    types: BUY_ORDER_TYPES,
    primaryType: 'BuyOrder',
    domain,
    message,
  };
}

/**
 * JSON-safe view of the typed-data (bigints -> strings) for transport to the
 * client and for logging. The client signs the bigint-encoded form via ethers.
 */
function typedDataToWire(typedData) {
  return {
    types: typedData.types,
    primaryType: typedData.primaryType,
    domain: typedData.domain,
    message: {
      maxEnergyKwh: typedData.message.maxEnergyKwh.toString(),
      maxUnitPriceMicroCc: typedData.message.maxUnitPriceMicroCc.toString(),
      maxTotalCc: typedData.message.maxTotalCc.toString(),
      expiresAt: typedData.message.expiresAt.toString(),
      nonce: typedData.message.nonce.toString(),
    },
  };
}

/**
 * Recover the signer of a buy-order signature over the canonical typed data.
 * Returns the lowercase address, or null if the signature is malformed.
 */
function recoverSigner(typedData, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return null;
  try {
    return ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      signature,
    ).toLowerCase();
  } catch {
    return null;
  }
}

class BuyOrderError extends Error {
  constructor(message, code = 'BUY_ORDER_INVALID', statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const parsePositiveNumber = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BuyOrderError(`${field} must be a positive finite number.`, 'BUY_ORDER_INVALID_BOUNDS');
  }
  return n;
};

const validateBounds = ({ maxEnergyKwh, maxUnitPriceCc, maxTotalCc }) => {
  const energy = parsePositiveNumber(maxEnergyKwh, 'maxEnergyKwh');
  const unit = parsePositiveNumber(maxUnitPriceCc, 'maxUnitPriceCc');
  const total = parsePositiveNumber(maxTotalCc, 'maxTotalCc');

  if (energy > MAX_ENERGY_KWH) {
    throw new BuyOrderError(`maxEnergyKwh exceeds the allowed cap (${MAX_ENERGY_KWH}).`, 'BUY_ORDER_BOUNDS_CAP');
  }
  if (unit > MAX_UNIT_PRICE_CC) {
    throw new BuyOrderError(`maxUnitPriceCc exceeds the allowed cap (${MAX_UNIT_PRICE_CC}).`, 'BUY_ORDER_BOUNDS_CAP');
  }
  if (total > MAX_TOTAL_CC) {
    throw new BuyOrderError(`maxTotalCc exceeds the allowed cap (${MAX_TOTAL_CC}).`, 'BUY_ORDER_BOUNDS_CAP');
  }
  // Self-consistency: the stated max total must be able to cover at least one
  // unit of energy at the stated max unit price, otherwise the intent is
  // internally contradictory (cannot ever be matched).
  if (total < unit) {
    throw new BuyOrderError(
      'maxTotalCc must be greater than or equal to maxUnitPriceCc.',
      'BUY_ORDER_INVALID_BOUNDS',
    );
  }

  return { energy, unit, total };
};

const validateExpiry = (expiresAtUnix) => {
  if (!Number.isFinite(Number(expiresAtUnix))) {
    throw new BuyOrderError('expiresAt must be provided as unix seconds.', 'BUY_ORDER_INVALID_EXPIRY');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Number(expiresAtUnix) - nowSec;
  if (ttl <= 0) {
    throw new BuyOrderError('expiresAt must be in the future.', 'BUY_ORDER_INVALID_EXPIRY');
  }
  if (ttl > MAX_TTL_SECONDS) {
    throw new BuyOrderError(`expiresAt exceeds the maximum TTL (${MAX_TTL_SECONDS}s).`, 'BUY_ORDER_INVALID_EXPIRY');
  }
  return new Date(Number(expiresAtUnix) * 1000);
};

/**
 * Create a buy order from a client-provided signature.
 *
 * @param {object} opts
 * @param {object} opts.user  authenticated Mongoose user doc (must have walletAddress)
 * @param {string} opts.signature
 * @param {number} opts.maxEnergyKwh
 * @param {number} opts.maxUnitPriceCc
 * @param {number} opts.maxTotalCc
 * @param {number} opts.expiresAtUnix
 * @param {number} opts.nonce
 * @param {object} [opts.req]  express req (for audit attribution)
 * @returns {Promise<object>} persisted intent (lean)
 */
async function createBuyOrder({
  user,
  signature,
  maxEnergyKwh,
  maxUnitPriceCc,
  maxTotalCc,
  expiresAtUnix,
  nonce,
  req,
}) {
  if (!user || !user.walletAddress || !ADDRESS_RE.test(user.walletAddress)) {
    throw new BuyOrderError('Authenticated user has no valid wallet address.', 'BUY_ORDER_NO_WALLET');
  }
  const walletAddress = user.walletAddress.toLowerCase();

  if (!Number.isFinite(Number(nonce)) || Number(nonce) < 0) {
    throw new BuyOrderError('nonce must be a non-negative integer.', 'BUY_ORDER_INVALID_NONCE');
  }

  const { energy, unit, total } = validateBounds({ maxEnergyKwh, maxUnitPriceCc, maxTotalCc });
  const expiresAt = validateExpiry(expiresAtUnix);

  // Rebuild the canonical typed-data from the *declared* bounds and verify the
  // signature recovers to the caller's own wallet. The client cannot lie about
  // bounds: it must sign exactly what it declares.
  const typedData = buildTypedData({
    maxEnergyKwh: energy,
    maxUnitPriceCc: unit,
    maxTotalCc: total,
    expiresAtUnix: Number(expiresAtUnix),
    nonce: Number(nonce),
  });
  const signer = recoverSigner(typedData, signature);
  if (!signer || signer !== walletAddress) {
    throw new BuyOrderError(
      'Signature could not be verified for the declared bounds and wallet.',
      'BUY_ORDER_BAD_SIGNATURE',
    );
  }

  // Monotonic per-user nonce — a captured signature cannot be replayed.
  const lastNonceDoc = await BuyOrder.findOne({ userId: user._id })
    .sort({ nonce: -1 })
    .select({ nonce: 1 })
    .lean();
  const lastNonce = lastNonceDoc ? Number(lastNonceDoc.nonce) : -1;
  if (Number(nonce) <= lastNonce) {
    throw new BuyOrderError(
      'nonce must be greater than the last used nonce (replay protection).',
      'BUY_ORDER_STALE_NONCE',
    );
  }

  const doc = await BuyOrder.create({
    userId: user._id,
    signer: walletAddress,
    signature,
    typedData: typedDataToWire(typedData),
    nonce: Number(nonce),
    maxEnergyKwh: energy,
    maxUnitPriceCc: unit,
    maxTotalCc: total,
    chainId: config.getChainId(),
    expiresAt,
    status: 'active',
    sourceIp: req?.ip || null,
    sourceUserAgent: req?.get?.('user-agent') || null,
  });

  try {
    const auditService = require('../services/auditService');
    await auditService.log({
      actor: user,
      action: 'BUY_ORDER_CREATED',
      resourceType: 'buyOrder',
      resourceId: String(doc._id),
      metadata: {
        maxEnergyKwh: energy,
        maxUnitPriceCc: unit,
        maxTotalCc: total,
        nonce: Number(nonce),
        expiresAt: expiresAt.toISOString(),
      },
      req,
      severity: 'info',
    });
  } catch {
    // audit logging is best-effort; never block on it
  }

  return sanitizeForOwner(doc);
}

const sanitizeForOwner = (doc) => {
  const obj = doc.toObject ? doc.toObject() : doc;
  delete obj.signature;
  delete obj.typedData;
  delete obj.sourceIp;
  delete obj.sourceUserAgent;
  return obj;
};

/**
 * List buy orders. By default returns only the caller's own orders (bidder
 * privacy). When `scope: 'mine'` the ownerId filter is enforced regardless of
 * input so a caller cannot read other users' intents.
 */
async function listBuyOrders({ user, ownerId = null, status = null, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  // Default to the caller's own orders; ownerId is honored only if it resolves
  // to the caller (privacy guard). Admin listing is handled separately.
  const targetOwner = ownerId && String(ownerId) === String(user?._id) ? ownerId : user?._id;
  filter.userId = targetOwner;

  if (status && BuyOrder.STATUS_VALUES.includes(status)) {
    filter.status = status;
  }

  const [docs, total] = await Promise.all([
    BuyOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    BuyOrder.countDocuments(filter),
  ]);

  return {
    orders: docs.map(sanitizeForOwner),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * Admin listing — full visibility (still omits the raw signature/typed-data).
 */
async function listAllBuyOrders({ status = null, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  if (status && BuyOrder.STATUS_VALUES.includes(status)) {
    filter.status = status;
  }

  const [docs, total] = await Promise.all([
    BuyOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    BuyOrder.countDocuments(filter),
  ]);

  return {
    orders: docs.map(sanitizeForOwner),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * Cancel one of the caller's own active buy orders.
 */
async function cancelBuyOrder({ id, user, reason = 'user_request', req }) {
  if (!id) throw new BuyOrderError('Buy order id is required.', 'BUY_ORDER_INVALID');
  const doc = await BuyOrder.findById(id).select({ userId: 1, status: 1 });
  if (!doc) throw new BuyOrderError('Buy order not found.', 'BUY_ORDER_NOT_FOUND', 404);
  if (String(doc.userId) !== String(user?._id)) {
    // Don't reveal existence to non-owners — return generic not found.
    throw new BuyOrderError('Buy order not found.', 'BUY_ORDER_NOT_FOUND', 404);
  }
  if (doc.status !== 'active') {
    throw new BuyOrderError(`Buy order is already ${doc.status}.`, 'BUY_ORDER_NOT_ACTIVE', 409);
  }

  doc.status = 'cancelled';
  doc.cancelledAt = new Date();
  doc.cancelledReason = String(reason).slice(0, 255);
  await doc.save();

  try {
    const auditService = require('../services/auditService');
    await auditService.log({
      actor: user,
      action: 'BUY_ORDER_CANCELLED',
      resourceType: 'buyOrder',
      resourceId: String(doc._id),
      metadata: { reason: doc.cancelledReason },
      req,
      severity: 'info',
    });
  } catch {
    // best-effort
  }

  return sanitizeForOwner(doc);
}

/**
 * Aggregate active, unexpired buy demand into a price-level (bids) ladder.
 * Privacy-preserving: returns only price levels + cumulative energy — never
 * per-wallet data. Used by the order-book depth endpoint.
 */
async function getActiveBuyDepth() {
  const now = new Date();
  const docs = await BuyOrder.find({
    status: 'active',
    expiresAt: { $gt: now },
  })
    .select({ maxEnergyKwh: 1, maxUnitPriceCc: 1, maxTotalCc: 1 })
    .lean();

  if (docs.length === 0) {
    return {
      levels: [],
      bidCount: 0,
      totalDemandEnergy: 0,
      totalDemandVolumeCc: 0,
      bestBidUnitPriceCc: 0,
      computedAt: new Date().toISOString(),
    };
  }

  // Aggregate by unit price (bids are best-highest-first).
  const byPrice = new Map();
  let totalEnergy = 0;
  let totalVolume = 0;
  for (const d of docs) {
    const unit = Number(d.maxUnitPriceCc) || 0;
    const energy = Number(d.maxEnergyKwh) || 0;
    const spendable = Math.min(Number(d.maxTotalCc) || 0, unit * energy);
    const entry = byPrice.get(unit) || { unitPriceCc: unit, energyKw: 0, volumeCc: 0, orderCount: 0 };
    entry.energyKw += energy;
    entry.volumeCc += spendable;
    entry.orderCount += 1;
    byPrice.set(unit, entry);
    totalEnergy += energy;
    totalVolume += spendable;
  }

  const levels = [...byPrice.values()]
    .sort((a, b) => b.unitPriceCc - a.unitPriceCc)
    .map((lvl) => ({
      ...lvl,
      unitPriceCc: Math.round(lvl.unitPriceCc * 1e6) / 1e6,
    }));

  let cumulative = 0;
  for (const lvl of levels) {
    cumulative += lvl.energyKw;
    lvl.cumulativeEnergyKw = Math.round(cumulative * 1e6) / 1e6;
  }

  return {
    levels,
    bidCount: docs.length,
    totalDemandEnergy: totalEnergy,
    totalDemandVolumeCc: totalVolume,
    bestBidUnitPriceCc: levels.length > 0 ? levels[0].unitPriceCc : 0,
    computedAt: new Date().toISOString(),
  };
}

module.exports = {
  BUY_ORDER_TYPES,
  buildTypedData,
  typedDataToWire,
  recoverSigner,
  validateBounds,
  validateExpiry,
  createBuyOrder,
  listBuyOrders,
  listAllBuyOrders,
  cancelBuyOrder,
  getActiveBuyDepth,
  BuyOrderError,
  sanitizeForOwner,
  // exported for config/test surface:
  configSurface: {
    MAX_ENERGY_KWH,
    MAX_UNIT_PRICE_CC,
    MAX_TOTAL_CC,
    MAX_TTL_SECONDS,
  },
};
