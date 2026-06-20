/**
 * Auto-listing policy controller (Sub-module 2.3.2 + 2.3.4 + 2.3.5).
 *
 * User-managed, opt-in policy CRUD plus the EIP-712 intent enable/disable flow
 * and the notification surface. All access is strictly scoped to the caller's
 * own policies + notifications — a user can never read or mutate another
 * user's policy/intent/notification.
 *
 * Guardrails enforced here:
 *   - Node ownership: a policy may only target a node the caller owns.
 *   - Opt-in: `enabled` defaults to false and can only be flipped true via the
 *     `/enable` flow, which requires a verified wallet signature.
 *   - Rate-limited + CSRF-safe (JWT/cookie auth via the v1 guard chain).
 *   - Every create/update/enable/disable/delete is audit-logged.
 */

const mongoose = require('mongoose');
const AutoListingPolicy = require('../models/AutoListingPolicy');
const EnergyNode = require('../models/EnergyNode');
const User = require('../models/User');
const auditService = require('../services/auditService');
const listingIntentService = require('../services/pricing/listingIntentService');
const notificationService = require('../services/notificationService');
const autoConfig = require('../config/autoTrading');
const asyncHandler = require('../utils/asyncHandler');

const { WALLET_REGEX } = require('../utils/validators');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const STRATEGIES = AutoListingPolicy.PRICE_STRATEGIES;
const CHANNELS = AutoListingPolicy.NOTIFY_CHANNELS;

const sanitizeChannels = (channels) => {
  if (!Array.isArray(channels)) return ['in_app'];
  const filtered = channels.filter((c) => CHANNELS.includes(c));
  return filtered.length ? filtered : ['in_app'];
};

/**
 * Resolve + authorize a node the caller owns. Returns { ok, node } or sends 4xx.
 */
async function resolveOwnedNode(req, res, nodeId) {
  if (!nodeId || !isValidObjectId(nodeId)) {
    res.status(400).json({ success: false, message: 'A valid nodeId is required' });
    return { ok: false };
  }
  const node = await EnergyNode.findById(nodeId).select('_id userId name status').lean();
  if (!node) {
    res.status(404).json({ success: false, message: 'Node not found' });
    return { ok: false };
  }
  if (String(node.userId) !== String(req.user._id)) {
    auditService
      .log({
        actor: req.user,
        action: 'AUTO_POLICY_NODE_DENIED',
        resourceType: 'node',
        resourceId: nodeId,
        metadata: { reason: 'not_owner' },
        req,
        severity: 'warn',
      })
      .catch(() => {});
    res.status(403).json({ success: false, message: 'Not authorized to use this node' });
    return { ok: false };
  }
  return { ok: true, node };
}

/* ── EIP-712 domain + intent bootstrap ─────────────────────────────── */

const getEip712Domain = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('walletAddress').lean();
  if (!user || !user.walletAddress || !WALLET_REGEX.test(user.walletAddress)) {
    return res.status(400).json({
      success: false,
      message: 'Connect + verify a wallet address in your profile before enabling auto-trading.',
      code: 'NO_WALLET',
    });
  }

  const nonce = await listingIntentService.nextNonceForUser(req.user._id);
  const ttlMs = autoConfig.getIntentTtlMs();
  const expiresAtUnix = Math.floor((Date.now() + ttlMs) / 1000);

  // Build an example typed-data so the frontend can sign the EXACT canonical
  // structure (guarantees client/server encoding agreement).
  const example = listingIntentService.buildTypedData({
    policyId: 'POLICY_OBJECT_ID_HERE',
    maxEnergyKwh: 100,
    minUnitPriceCc: autoConfig.toFinite(undefined, 0),
    maxUnitPriceCc: autoConfig.toFinite(undefined, 0),
    maxTotalCc: 1000,
    expiresAtUnix,
    nonce,
  });

  res.status(200).json({
    success: true,
    data: {
      domain: example.domain,
      types: example.types,
      primaryType: example.primaryType,
      walletAddress: user.walletAddress,
      suggested: {
        nonce,
        expiresAtUnix,
        expiresAtIso: new Date(expiresAtUnix * 1000).toISOString(),
        maxEnergyKwhCeiling: 100000,
      },
    },
  });
});

/* ── Policy CRUD ───────────────────────────────────────────────────── */

const listPolicies = asyncHandler(async (req, res) => {
  const policies = await AutoListingPolicy.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .populate({ path: 'nodeId', select: 'name status nodeType sourceType' })
    .lean();

  res.status(200).json({ success: true, data: policies.map(toPolicyResponse) });
});

const getPolicy = asyncHandler(async (req, res) => {
  const policy = await findOwnedPolicyOr404(req, res);
  if (!policy) return;
  await policy.populate({ path: 'nodeId', select: 'name status nodeType sourceType' });
  res.status(200).json({ success: true, data: toPolicyResponse(policy) });
});

const createPolicy = asyncHandler(async (req, res) => {
  const {
    nodeId,
    priceStrategy,
    minSurplusKwh,
    maxListingsPerDay,
    maxTotalCcPerDay,
    minTimeBetweenListingsMs,
    fixedDiscountPercent,
    minUnitPriceCc,
    maxUnitPriceCc,
    notifyChannels,
  } = req.body || {};

  const resolved = await resolveOwnedNode(req, res, nodeId);
  if (!resolved.ok) return;
  const { node } = resolved;

  if (priceStrategy && !STRATEGIES.includes(priceStrategy)) {
    return res.status(400).json({ success: false, message: `priceStrategy must be one of: ${STRATEGIES.join(', ')}` });
  }

  const doc = await AutoListingPolicy.create({
    userId: req.user._id,
    nodeId: node._id,
    enabled: false, // always opt-in; enable via the signed-intent flow
    priceStrategy: priceStrategy || 'forecast_derived',
    minSurplusKwh: clampNumber(minSurplusKwh, 0, Infinity, autoConfig.getMinSurplusKwhDefault()),
    maxListingsPerDay: autoConfig.clampMaxListingsPerDay(maxListingsPerDay),
    maxTotalCcPerDay: autoConfig.clampMaxTotalCcPerDay(maxTotalCcPerDay),
    minTimeBetweenListingsMs: autoConfig.clampMinTimeBetweenMs(minTimeBetweenListingsMs),
    fixedDiscountPercent: clampNumber(fixedDiscountPercent, 0, 90, autoConfig.getFixedDiscountPercentDefault()),
    minUnitPriceCc: minUnitPriceCc == null ? null : clampNumber(minUnitPriceCc, 0, Infinity, null),
    maxUnitPriceCc: maxUnitPriceCc == null ? null : clampNumber(maxUnitPriceCc, 0, Infinity, null),
    notifyChannels: sanitizeChannels(notifyChannels),
    notifyOnly: true, // v1 hard default
  }).catch((err) => {
    if (err && err.code === 11000) {
      const e = new Error('A policy already exists for this node. Update it instead of creating a new one.');
      e.statusCode = 409;
      e.code = 'POLICY_EXISTS';
      throw e;
    }
    throw err;
  });

  await auditService.log({
    actor: req.user,
    action: 'AUTO_POLICY_CREATED',
    resourceType: 'auto_trading',
    resourceId: String(doc._id),
    metadata: { nodeId: String(node._id), priceStrategy: doc.priceStrategy },
    req,
    severity: 'info',
  });

  res.status(201).json({ success: true, data: toPolicyResponse(doc) });
});

const updatePolicy = asyncHandler(async (req, res) => {
  const policy = await findOwnedPolicyOr404(req, res, { mutable: true });
  if (!policy) return;

  const updates = {};
  const b = req.body || {};

  if (b.priceStrategy !== undefined) {
    if (!STRATEGIES.includes(b.priceStrategy)) {
      return res.status(400).json({ success: false, message: `priceStrategy must be one of: ${STRATEGIES.join(', ')}` });
    }
    updates.priceStrategy = b.priceStrategy;
  }
  if (b.minSurplusKwh !== undefined) updates.minSurplusKwh = clampNumber(b.minSurplusKwh, 0, Infinity, policy.minSurplusKwh);
  if (b.maxListingsPerDay !== undefined) updates.maxListingsPerDay = autoConfig.clampMaxListingsPerDay(b.maxListingsPerDay);
  if (b.maxTotalCcPerDay !== undefined) updates.maxTotalCcPerDay = autoConfig.clampMaxTotalCcPerDay(b.maxTotalCcPerDay);
  if (b.minTimeBetweenListingsMs !== undefined) updates.minTimeBetweenListingsMs = autoConfig.clampMinTimeBetweenMs(b.minTimeBetweenListingsMs);
  if (b.fixedDiscountPercent !== undefined) updates.fixedDiscountPercent = clampNumber(b.fixedDiscountPercent, 0, 90, policy.fixedDiscountPercent);
  if (b.minUnitPriceCc !== undefined) updates.minUnitPriceCc = b.minUnitPriceCc == null ? null : clampNumber(b.minUnitPriceCc, 0, Infinity, null);
  if (b.maxUnitPriceCc !== undefined) updates.maxUnitPriceCc = b.maxUnitPriceCc == null ? null : clampNumber(b.maxUnitPriceCc, 0, Infinity, null);
  if (b.notifyChannels !== undefined) updates.notifyChannels = sanitizeChannels(b.notifyChannels);

  const updated = await AutoListingPolicy.findByIdAndUpdate(policy._id, { $set: updates }, { new: true, runValidators: true }).lean();

  await auditService.log({
    actor: req.user,
    action: 'AUTO_POLICY_UPDATED',
    resourceType: 'auto_trading',
    resourceId: String(policy._id),
    metadata: { fields: Object.keys(updates) },
    req,
    severity: 'info',
  });

  res.status(200).json({ success: true, data: toPolicyResponse(updated) });
});

const deletePolicy = asyncHandler(async (req, res) => {
  const policy = await findOwnedPolicyOr404(req, res);
  if (!policy) return;

  if (policy.activeIntentId) {
    await listingIntentService.revokeIntent(policy.activeIntentId, 'policy_deleted').catch(() => {});
  }
  await AutoListingPolicy.deleteOne({ _id: policy._id });

  await auditService.log({
    actor: req.user,
    action: 'AUTO_POLICY_DELETED',
    resourceType: 'auto_trading',
    resourceId: String(policy._id),
    metadata: { nodeId: String(policy.nodeId) },
    req,
    severity: 'warn',
  });

  res.status(200).json({ success: true, data: {} });
});

/* ── Enable / disable (signed intent flow) ─────────────────────────── */

const enablePolicy = asyncHandler(async (req, res) => {
  if (!autoConfig.isAutoTradingEnvEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'Auto-trading is disabled in this environment.',
      code: 'AUTO_TRADING_DISABLED',
    });
  }

  const policy = await findOwnedPolicyOr404(req, res);
  if (!policy) return;

  const user = await User.findById(req.user._id).select('walletAddress email').lean();
  if (!user || !user.walletAddress || !WALLET_REGEX.test(user.walletAddress)) {
    return res.status(400).json({
      success: false,
      message: 'Connect + verify a wallet address in your profile before enabling auto-trading.',
      code: 'NO_WALLET',
    });
  }

  const {
    signature,
    maxEnergyKwh,
    minUnitPriceCc,
    maxUnitPriceCc,
    maxTotalCc,
    expiresAtUnix,
    nonce,
  } = req.body || {};

  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return res.status(400).json({ success: false, message: 'A signature is required', code: 'NO_SIGNATURE' });
  }

  const intent = await listingIntentService
    .createVerifiedIntent({
      userId: req.user._id,
      policyId: policy._id,
      signature,
      maxEnergyKwh,
      minUnitPriceCc,
      maxUnitPriceCc,
      maxTotalCc,
      expiresAtUnix,
      nonce,
      expectedWallet: user.walletAddress,
      sourceIp: req.ip || null,
      sourceUserAgent: req.headers['user-agent'] || null,
    })
    .catch((err) => {
      err.statusCode = err.statusCode || 400;
      throw err;
    });

  // Revoke any previous active intent for this policy to keep one live intent.
  if (policy.activeIntentId && String(policy.activeIntentId) !== String(intent._id)) {
    await listingIntentService.revokeIntent(policy.activeIntentId, 'superseded').catch(() => {});
  }

  const updated = await AutoListingPolicy.findByIdAndUpdate(
    policy._id,
    { $set: { enabled: true, activeIntentId: intent._id, notifyOnly: true, disabledReason: null } },
    { new: true },
  ).lean();

  await auditService.log({
    actor: req.user,
    action: 'AUTO_POLICY_ENABLED',
    resourceType: 'auto_trading',
    resourceId: String(policy._id),
    metadata: {
      intentId: String(intent._id),
      intentExpiresAt: intent.expiresAt,
      maxEnergyKwh: intent.maxEnergyKwh,
      signer: intent.signer,
    },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'Auto-listing enabled. You will be notified of listing opportunities. Confirm each listing in MetaMask.',
    data: toPolicyResponse(updated),
  });
});

const disablePolicy = asyncHandler(async (req, res) => {
  const policy = await findOwnedPolicyOr404(req, res, { mutable: true });
  if (!policy) return;

  if (policy.activeIntentId) {
    await listingIntentService.revokeIntent(policy.activeIntentId, 'policy_disabled').catch(() => {});
  }

  const updated = await AutoListingPolicy.findByIdAndUpdate(
    policy._id,
    { $set: { enabled: false, activeIntentId: null, disabledReason: req.body?.reason || 'user_disabled' } },
    { new: true },
  ).lean();

  await auditService.log({
    actor: req.user,
    action: 'AUTO_POLICY_DISABLED',
    resourceType: 'auto_trading',
    resourceId: String(policy._id),
    metadata: { reason: req.body?.reason || 'user_disabled' },
    req,
    severity: 'warn',
  });

  res.status(200).json({ success: true, data: toPolicyResponse(updated) });
});

/* ── Notifications ─────────────────────────────────────────────────── */

const listNotifications = asyncHandler(async (req, res) => {
  const result = await notificationService.list({
    userId: req.user._id,
    type: req.query.type || null,
    unreadOnly: req.query.unreadOnly === 'true',
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ success: true, data: result.data, meta: result.meta });
});

const markNotificationRead = asyncHandler(async (req, res) => {
  const doc = await notificationService.markRead(req.params.id, req.user._id);
  if (!doc) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.status(200).json({ success: true, data: doc });
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  const n = await notificationService.markAllRead(req.user._id);
  res.status(200).json({ success: true, data: { updated: n } });
});

const dismissNotification = asyncHandler(async (req, res) => {
  const doc = await notificationService.dismiss(req.params.id, req.user._id);
  if (!doc) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.status(200).json({ success: true, data: doc });
});

/* ── Helpers ───────────────────────────────────────────────────────── */

async function findOwnedPolicyOr404(req, res, { mutable = false } = {}) {
  const id = req.params.id;
  if (!isValidObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid policy id' });
    return null;
  }
  const policy = await AutoListingPolicy.findById(id).lean();
  if (!policy) {
    res.status(404).json({ success: false, message: 'Policy not found' });
    return null;
  }
  if (String(policy.userId) !== String(req.user._id)) {
    auditService
      .log({
        actor: req.user,
        action: 'AUTO_POLICY_ACCESS_DENIED',
        resourceType: 'auto_trading',
        resourceId: id,
        metadata: { reason: 'not_owner' },
        req,
        severity: 'warn',
      })
      .catch(() => {});
    res.status(403).json({ success: false, message: 'Not authorized' });
    return null;
  }
  return policy;
}

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (max !== Infinity && n > max) return max;
  return n;
};

const toPolicyResponse = (policy) => {
  if (!policy) return null;
  const node = policy.nodeId && typeof policy.nodeId === 'object' ? policy.nodeId : null;
  return {
    id: String(policy._id),
    nodeId: String(policy.nodeId),
    node: node ? { id: String(node._id), name: node.name, status: node.status, nodeType: node.nodeType } : null,
    enabled: Boolean(policy.enabled),
    notifyOnly: policy.notifyOnly !== false,
    priceStrategy: policy.priceStrategy,
    minSurplusKwh: policy.minSurplusKwh,
    maxListingsPerDay: policy.maxListingsPerDay,
    maxTotalCcPerDay: policy.maxTotalCcPerDay,
    minTimeBetweenListingsMs: policy.minTimeBetweenListingsMs,
    fixedDiscountPercent: policy.fixedDiscountPercent,
    minUnitPriceCc: policy.minUnitPriceCc,
    maxUnitPriceCc: policy.maxUnitPriceCc,
    notifyChannels: policy.notifyChannels,
    activeIntentId: policy.activeIntentId ? String(policy.activeIntentId) : null,
    lastMatchedAt: policy.lastMatchedAt || null,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
};

module.exports = {
  getEip712Domain,
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  deletePolicy,
  enablePolicy,
  disablePolicy,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
};
