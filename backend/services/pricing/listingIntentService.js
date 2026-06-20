/**
 * Listing intent service (Sub-module 2.3.4).
 *
 * Builds + verifies the EIP-712 off-chain listing intent the user signs in
 * MetaMask when enabling an auto-listing policy. The backend NEVER holds a
 * private key — it only:
 *   1. rebuilds the canonical typed-data from the *declared* bounds,
 *   2. recovers the signer from the signature,
 *   3. asserts the recovered signer equals the user's walletAddress,
 *   4. enforces per-user monotonic nonces (replay protection),
 *   5. persists the signature + bounds + nonce (nothing secret).
 *
 * Security model: the client cannot forge authority. If it declares bounds A
 * but signs bounds B, verification against the canonical rebuild of A fails.
 * If it signs for wallet X but the account is wallet Y, the address check fails.
 * A captured signature is useless once consumed or past expiry, and a stale
 * nonce is rejected.
 */

const { ethers } = require('ethers');
const ListingIntent = require('../../models/ListingIntent');
const config = require('../../config/autoTrading');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Canonical EIP-712 type schema. Both the signer (frontend) and the verifier
 * (here) MUST use this exact schema. Exposed via the domain endpoint so the
 * frontend never has to hardcode it.
 */
const INTENT_TYPES = {
  ListingIntent: [
    { name: 'policyId', type: 'string' },
    { name: 'maxEnergyKwh', type: 'uint256' },
    { name: 'minUnitPriceMicroCc', type: 'uint256' },
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
 * Build the canonical EIP-712 typed-data for a listing intent.
 *
 * @param {object} opts
 * @param {string} opts.policyId
 * @param {number} opts.maxEnergyKwh
 * @param {number|null} opts.minUnitPriceCc
 * @param {number|null} opts.maxUnitPriceCc
 * @param {number|null} opts.maxTotalCc
 * @param {number} opts.expiresAtUnix  unix seconds
 * @param {number} opts.nonce
 * @returns {{types, primaryType, domain, message}} typed-data with bigint uints
 */
function buildTypedData({
  policyId,
  maxEnergyKwh,
  minUnitPriceCc,
  maxUnitPriceCc,
  maxTotalCc,
  expiresAtUnix,
  nonce,
}) {
  const domain = {
    name: config.EIP712_DOMAIN_NAME,
    version: config.EIP712_DOMAIN_VERSION,
    chainId: config.getChainId(),
    verifyingContract: config.getEnergyTradingAddress(),
  };

  const message = {
    policyId: String(policyId),
    maxEnergyKwh: toUint(maxEnergyKwh),
    minUnitPriceMicroCc: toMicroCcUint(minUnitPriceCc),
    maxUnitPriceMicroCc: toMicroCcUint(maxUnitPriceCc),
    maxTotalCc: toUint(maxTotalCc),
    expiresAt: toUint(expiresAtUnix),
    nonce: toUint(nonce),
  };

  return {
    types: INTENT_TYPES,
    primaryType: 'ListingIntent',
    domain,
    message,
  };
}

/**
 * JSON-safe view of the typed-data (bigints → strings) for transport to the
 * client and for logging. The client signs the bigint-encoded form via ethers.
 */
function typedDataToWire(typedData) {
  return {
    types: typedData.types,
    primaryType: typedData.primaryType,
    domain: typedData.domain,
    message: {
      policyId: typedData.message.policyId,
      maxEnergyKwh: typedData.message.maxEnergyKwh.toString(),
      minUnitPriceMicroCc: typedData.message.minUnitPriceMicroCc.toString(),
      maxUnitPriceMicroCc: typedData.message.maxUnitPriceMicroCc.toString(),
      maxTotalCc: typedData.message.maxTotalCc.toString(),
      expiresAt: typedData.message.expiresAt.toString(),
      nonce: typedData.message.nonce.toString(),
    },
  };
}

/**
 * Recover the signer of a listing-intent signature over the canonical typed
 * data. Returns the lowercase address, or null if the signature is malformed.
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

/**
 * Verify a client-provided signature against the canonical rebuild of the
 * declared bounds. Throws a structured error on any mismatch so the caller can
 * surface a precise 4xx.
 *
 * @returns {{signer:string, typedData:object}} the recovered signer + canonical typed data
 */
function verifyIntentSignature({
  policyId,
  maxEnergyKwh,
  minUnitPriceCc,
  maxUnitPriceCc,
  maxTotalCc,
  expiresAtUnix,
  nonce,
  signature,
  expectedWallet,
}) {
  if (!expectedWallet || !ADDRESS_RE.test(expectedWallet)) {
    const err = new Error('A valid wallet address is required to verify the intent');
    err.statusCode = 400;
    err.code = 'INVALID_WALLET';
    throw err;
  }

  const typedData = buildTypedData({
    policyId,
    maxEnergyKwh,
    minUnitPriceCc,
    maxUnitPriceCc,
    maxTotalCc,
    expiresAtUnix,
    nonce,
  });

  const recovered = recoverSigner(typedData, signature);
  if (!recovered) {
    const err = new Error('Malformed signature');
    err.statusCode = 400;
    err.code = 'MALFORMED_SIGNATURE';
    throw err;
  }

  if (recovered !== expectedWallet.toLowerCase()) {
    const err = new Error(
      'Signature signer does not match your wallet address. Reconnect the correct wallet and sign again.',
    );
    err.statusCode = 403;
    err.code = 'SIGNER_MISMATCH';
    throw err;
  }

  return { signer: recovered, typedData };
}

/**
 * Next monotonic nonce for a user (replay protection). Starts at 1.
 */
async function nextNonceForUser(userId) {
  const last = await ListingIntent.findOne({ userId })
    .sort({ nonce: -1 })
    .select('nonce')
    .lean();
  const next = (last?.nonce ?? 0) + 1;
  return next;
}

/**
 * Create + persist a verified listing intent. Verifies the signature, checks
 * the nonce is strictly greater than the stored max, then stores it. Returns
 * the created intent (without sensitive transport fields in default projection).
 */
async function createVerifiedIntent({
  userId,
  policyId,
  signature,
  maxEnergyKwh,
  minUnitPriceCc,
  maxUnitPriceCc,
  maxTotalCc,
  expiresAtUnix,
  nonce,
  expectedWallet,
  sourceIp = null,
  sourceUserAgent = null,
}) {
  // Sanity: maxEnergyKwh and expiry must be present + sane.
  const energy = Math.max(0, Math.floor(Number(maxEnergyKwh) || 0));
  if (energy <= 0) {
    const err = new Error('maxEnergyKwh must be a positive whole number');
    err.statusCode = 400;
    err.code = 'INVALID_BOUNDS';
    throw err;
  }
  if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= Math.floor(Date.now() / 1000)) {
    const err = new Error('Intent expiry must be in the future');
    err.statusCode = 400;
    err.code = 'INVALID_EXPIRY';
    throw err;
  }

  const { signer, typedData } = verifyIntentSignature({
    policyId,
    maxEnergyKwh: energy,
    minUnitPriceCc,
    maxUnitPriceCc,
    maxTotalCc,
    expiresAtUnix,
    nonce,
    signature,
    expectedWallet,
  });

  // Replay protection: the declared nonce must be strictly greater than the
  // stored max for this user (checked again under the unique-ish index).
  const currentMax = await nextNonceForUser(userId) - 1;
  if (Number(nonce) <= currentMax) {
    const err = new Error('Stale or replayed nonce');
    err.statusCode = 409;
    err.code = 'STALE_NONCE';
    throw err;
  }

  const intent = await ListingIntent.create({
    userId,
    policyId,
    signer,
    signature,
    typedData: typedDataToWire(typedData),
    nonce: Number(nonce),
    maxEnergyKwh: energy,
    minUnitPriceCc: minUnitPriceCc ?? null,
    maxUnitPriceCc: maxUnitPriceCc ?? null,
    maxTotalCc: maxTotalCc ?? null,
    chainId: typedData.domain.chainId,
    expiresAt: new Date(expiresAtUnix * 1000),
    status: 'active',
    sourceIp,
    sourceUserAgent,
  });

  return intent;
}

/**
 * The currently-active (non-expired, non-revoked) intent for a policy, if any.
 */
async function getActiveIntentForPolicy(policyId) {
  const now = new Date();
  return ListingIntent.findOne({
    policyId,
    status: 'active',
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Revoke an intent (e.g. on policy disable). Idempotent.
 */
async function revokeIntent(intentId, reason = null) {
  const intent = await ListingIntent.findById(intentId);
  if (!intent) return null;
  if (intent.status === 'active') {
    intent.status = 'revoked';
    intent.revokedAt = new Date();
    intent.revokedReason = reason;
    await intent.save();
  }
  return intent;
}

/**
 * Sweep expired active intents to 'expired'. Cheap; called from the matcher.
 */
async function sweepExpiredIntents() {
  const now = new Date();
  try {
    const res = await ListingIntent.updateMany(
      { status: 'active', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } },
      { bypassImmutability: false },
    );
    return res?.modifiedN || 0;
  } catch {
    return 0;
  }
}

module.exports = {
  INTENT_TYPES,
  buildTypedData,
  typedDataToWire,
  recoverSigner,
  verifyIntentSignature,
  nextNonceForUser,
  createVerifiedIntent,
  getActiveIntentForPolicy,
  revokeIntent,
  sweepExpiredIntents,
  toMicroCcUint,
  microCcToCc,
};
