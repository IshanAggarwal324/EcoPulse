/**
 * Auto-listing matcher service (Sub-module 2.3.3 core logic).
 *
 * Sits on top of the pricing engine + surplus detector (2.1/2.2) and decides,
 * per enabled AutoListingPolicy, whether a listing opportunity exists RIGHT
 * NOW and — in v1 (notify-only) — surfaces it as a user notification. It never
 * touches private keys or submits on-chain transactions; the user always
 * confirms the real listing in MetaMask.
 *
 * Guardrails enforced here (2.3):
 *   - Kill switch: env flag AND admin DB pause must both allow. Fail-closed.
 *   - Authority: a policy can only match while a valid (non-expired) signed
 *     ListingIntent exists; bounds on that intent hard-clamp every decision.
 *   - Idempotency: one job per (policyId, UTC hour). A duplicate tick is a
 *     no-op (Redis SETNX).
 *   - Hard limits: maxListingsPerDay, maxTotalCcPerDay, minTimeBetweenListings
 *     enforced via Redis counters; failing-safe to "skip" when Redis is down.
 *   - Eligibility reuses the surplusService duplicate-listing guard, so a
 *     node with an existing active listing is never recommended a second one.
 *   - 2.3.7: when surplus flips below threshold AND the user has an active
 *     listing, a one-per-hour 'stale listing' notification is sent instead.
 *   - Every match decision + notification is audit-logged (system actor).
 */

const AutoListingPolicy = require('../../models/AutoListingPolicy');
const AutoTradingConfig = require('../../models/AutoTradingConfig');
const EnergyNode = require('../../models/EnergyNode');
const User = require('../../models/User');
const ListingIntent = require('../../models/ListingIntent');
const surplusService = require('./surplusService');
const listingIntentService = require('./listingIntentService');
const notificationService = require('../notificationService');
const auditService = require('../auditService');
const { logBackgroundError } = require('../../utils/logger');
const pricingConfig = require('../../config/pricing');
const autoConfig = require('../../config/autoTrading');
const { getRedisClient, isRedisAvailable } = require('../../config/redis');

/* ------------------------------------------------------------------ */
/* Kill switch (env + admin DB pause)                                  */
/* ------------------------------------------------------------------ */

async function isAutoTradingActive() {
  if (!autoConfig.isAutoTradingEnvEnabled()) return false;
  try {
    const cfg = await AutoTradingConfig.getOrCreate();
    return !cfg.paused;
  } catch {
    // If the config store is unreachable, fail-closed.
    return false;
  }
}

async function getKillSwitchStatus() {
  const cfg = await AutoTradingConfig.getOrCreate().catch(() => null);
  return {
    envEnabled: autoConfig.isAutoTradingEnvEnabled(),
    autoSubmitEnabled: autoConfig.isAutoSubmitEnabled(),
    paused: cfg ? cfg.paused : true,
    active: autoConfig.isAutoTradingEnvEnabled() && cfg ? !cfg.paused : false,
    pausedAt: cfg?.pausedAt || null,
    pausedReason: cfg?.pausedReason || null,
  };
}

/* ------------------------------------------------------------------ */
/* Pure: price strategy + intent-bound clamping                        */
/* ------------------------------------------------------------------ */

/**
 * Apply the policy's price strategy to a surplus recommendation and clamp to
 * the policy's price bounds + the global floor/ceiling. Pure (no I/O).
 *
 * @returns {{energyAmount:number, unitPriceCc:number, totalPriceCc:number, reason:string}}
 */
function applyPriceStrategy({ recommendation, policy }) {
  let unitPriceCc = Number(recommendation.unitPriceCc);
  let reason = 'forecast_derived';

  if (!Number.isFinite(unitPriceCc) || unitPriceCc <= 0) {
    unitPriceCc = pricingConfig.getDefaultBasePriceCc();
    reason = 'fallback_base';
  }

  if (policy.priceStrategy === 'fixed_discount') {
    const disc = Math.min(0.9, Math.max(0, (Number(policy.fixedDiscountPercent) || 0) / 100));
    unitPriceCc = unitPriceCc * (1 - disc);
    reason = `fixed_discount_${Math.round(disc * 100)}pct`;
  }

  // Policy-specific bounds (null = inherit global).
  if (policy.minUnitPriceCc != null) {
    unitPriceCc = Math.max(unitPriceCc, Number(policy.minUnitPriceCc));
  }
  if (policy.maxUnitPriceCc != null) {
    unitPriceCc = Math.min(unitPriceCc, Number(policy.maxUnitPriceCc));
  }

  unitPriceCc = pricingConfig.clampPrice(unitPriceCc);

  const energyAmount = Math.max(0, Number(recommendation.energyAmount) || 0);
  // Total is energy * (already-clamped) unit. Do NOT apply the per-kWh
  // floor/ceiling to the total — that would cap large listings at the unit
  // ceiling. Intent bounds cap the absolute CC later (clampToIntentBounds).
  const totalPriceCc = Math.max(0, round6(energyAmount * unitPriceCc));

  return {
    energyAmount: round3(energyAmount),
    unitPriceCc: round6(unitPriceCc),
    totalPriceCc,
    reason,
  };
}

/**
 * Clamp a candidate decision to the signed intent's authorized bounds. A match
 * can never exceed what the wallet owner signed for. Pure.
 */
function clampToIntentBounds({ energy, unit, total, intent }) {
  let energyAmount = energy;
  let unitPriceCc = unit;
  let totalPriceCc = total;

  if (intent?.maxEnergyKwh != null) {
    energyAmount = Math.min(energyAmount, Number(intent.maxEnergyKwh));
  }
  if (intent?.minUnitPriceCc != null) {
    unitPriceCc = Math.max(unitPriceCc, Number(intent.minUnitPriceCc));
  }
  if (intent?.maxUnitPriceCc != null) {
    unitPriceCc = Math.min(unitPriceCc, Number(intent.maxUnitPriceCc));
  }
  unitPriceCc = pricingConfig.clampPrice(unitPriceCc);

  // Recompute total from the (possibly reduced) energy * unit. The per-kWh
  // ceiling applies to unit, NOT total; the intent's absolute CC ceiling caps
  // the total explicitly.
  totalPriceCc = Math.max(0, round6(round3(energyAmount) * unitPriceCc));
  if (intent?.maxTotalCc != null) {
    totalPriceCc = Math.min(totalPriceCc, Number(intent.maxTotalCc));
  }

  return {
    energyAmount: round3(Math.max(0, energyAmount)),
    unitPriceCc: round6(unitPriceCc),
    totalPriceCc: round6(totalPriceCc),
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/* ------------------------------------------------------------------ */
/* Redis quota / idempotency helpers                                   */
/* ------------------------------------------------------------------ */

function redis() {
  if (!isRedisAvailable()) return null;
  return getRedisClient();
}

/**
 * Atomically claim this policy's slot for the current UTC hour. Returns true
 * if THIS caller owns it (idempotency: a duplicate tick within the hour is a
 * no-op). Fail-safe: returns true when Redis is down (the worker separately
 * refuses to run when Redis is unavailable — see evaluateAll).
 */
async function claimJobSlot(policyId) {
  const client = redis();
  if (!client) return true;
  const key = `${autoConfig.KEYS.JOB}:${policyId}:${autoConfig.hourBucket()}`;
  try {
    const got = await client.set(key, '1', 'EX', autoConfig.getIdempotencyTtlSeconds(), 'NX');
    return got === 'OK';
  } catch {
    return true;
  }
}

async function getQuotaUsage(policyId) {
  const client = redis();
  const day = autoConfig.dayBucket();
  if (!client) return { listingsUsed: 0, ccUsed: 0, redisUp: false };
  try {
    const [listings, cc] = await Promise.all([
      client.get(`${autoConfig.KEYS.QUOTA_LISTINGS}:${policyId}:${day}`),
      client.get(`${autoConfig.KEYS.QUOTA_CC}:${policyId}:${day}`),
    ]);
    return {
      listingsUsed: parseInt(listings || '0', 10) || 0,
      ccUsed: parseFloat(cc || '0') || 0,
      redisUp: true,
    };
  } catch {
    return { listingsUsed: 0, ccUsed: 0, redisUp: false };
  }
}

/**
 * Increment the daily quotas after a matched decision. TTL ~36h so a counter
 * expires well past the UTC day it covers.
 */
async function recordQuotaUsage(policyId, totalCc) {
  const client = redis();
  if (!client) return;
  const day = autoConfig.dayBucket();
  const ttl = 36 * 3600;
  try {
    // INCR the daily listing counter, then set its TTL (idempotent). Do NOT
    // SET the value here — that would clobber the incremented counter.
    const listKey = `${autoConfig.KEYS.QUOTA_LISTINGS}:${policyId}:${day}`;
    await client.incr(listKey);
    await client.expire(listKey, ttl).catch(() => {});
    const ccKey = `${autoConfig.KEYS.QUOTA_CC}:${policyId}:${day}`;
    await client.incrbyfloat(ccKey, round6(totalCc));
    await client.expire(ccKey, ttl).catch(() => {});
    await client.set(`${autoConfig.KEYS.LAST_MATCH}:${policyId}`, String(Date.now()));
  } catch {
    // quota tracking is best-effort; the decision is still recorded in audit
  }
}

async function getLastMatchAgeMs(policyId) {
  const client = redis();
  if (!client) return null;
  try {
    const raw = await client.get(`${autoConfig.KEYS.LAST_MATCH}:${policyId}`);
    if (!raw) return null;
    return Date.now() - parseInt(raw, 10);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Batch preload for matcher ticks (H22)                               */
/* ------------------------------------------------------------------ */

/**
 * Preload nodes, users, intents, and marketplace counts for one matcher tick.
 * Recommendations are cached per nodeId so multiple policies on the same node
 * share one pricing/forecast round trip.
 */
async function buildEvaluationContext(policies, { now = new Date() } = {}) {
  const policyIds = policies.map((p) => p._id);
  const nodeIds = [...new Set(policies.map((p) => p.nodeId))];
  const userIds = [...new Set(policies.map((p) => p.userId))];

  const [nodes, users, intents] = await Promise.all([
    EnergyNode.find({ _id: { $in: nodeIds } })
      .select('_id userId name status nodeType')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('walletAddress email preferences isEmailVerified')
      .lean(),
    ListingIntent.find({
      policyId: { $in: policyIds },
      status: 'active',
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const nodeById = new Map(nodes.map((n) => [String(n._id), n]));
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const intentByPolicyId = new Map();
  for (const intent of intents) {
    const pid = String(intent.policyId);
    if (!intentByPolicyId.has(pid)) intentByPolicyId.set(pid, intent);
  }

  const listingCountByWallet = await surplusService.getActiveListingCountsByWallet(
    users.map((u) => u.walletAddress),
  );

  const recommendationByNodeId = new Map();

  const getRecommendation = async (node, user) => {
    const key = String(node._id);
    if (recommendationByNodeId.has(key)) return recommendationByNodeId.get(key);

    const walletKey = String(user?.walletAddress || '').toLowerCase();
    const activeListingCount = listingCountByWallet.get(walletKey) ?? 0;
    const recommendation = await surplusService.buildRecommendation({
      node,
      user,
      activeListingCount,
    });
    recommendationByNodeId.set(key, recommendation);
    return recommendation;
  };

  return {
    nodeById,
    userById,
    intentByPolicyId,
    getRecommendation,
  };
}

/* ------------------------------------------------------------------ */
/* Per-policy evaluation                                               */
/* ------------------------------------------------------------------ */

/**
 * Evaluate a single policy and return a decision WITHOUT side effects beyond
 * loading data. The orchestrator decides whether to act (notify) + record.
 *
 * @returns {Promise<object>} decision object
 */
async function evaluatePolicy(policy, ctx = null) {
  const base = {
    policyId: String(policy._id),
    nodeId: String(policy.nodeId),
    matched: false,
    stale: false,
    reason: null,
  };

  // Node must exist + be active.
  const node = ctx
    ? ctx.nodeById.get(String(policy.nodeId))
    : await EnergyNode.findById(policy.nodeId)
        .select('_id userId name status nodeType')
        .lean();
  if (!node) return { ...base, reason: 'node_missing' };
  if (String(node.userId) !== String(policy.userId)) {
    return { ...base, reason: 'ownership_mismatch' };
  }
  if (node.status !== 'active') return { ...base, reason: `node_${node.status}` };

  // Authority: a valid signed intent must exist.
  const intent = ctx
    ? ctx.intentByPolicyId.get(String(policy._id)) || null
    : await listingIntentService.getActiveIntentForPolicy(policy._id);
  if (!intent) return { ...base, reason: 'no_active_intent' };

  // User + wallet.
  const user = ctx
    ? ctx.userById.get(String(policy.userId))
    : await User.findById(policy.userId)
        .select('walletAddress email preferences isEmailVerified')
        .lean();
  if (!user || !user.walletAddress) return { ...base, reason: 'no_wallet' };

  // Build the surplus recommendation (reuses 2.2).
  let recommendation;
  try {
    recommendation = ctx
      ? await ctx.getRecommendation(node, user)
      : await surplusService.buildRecommendation({ node, user });
  } catch (err) {
    return { ...base, reason: 'recommendation_error', error: err.message };
  }

  const surplusKwh = recommendation.surplus?.totalSurplusKwh ?? 0;
  const hasActiveListing = recommendation.market?.activeListingCount > 0;

  // 2.3.7 — stale listing: surplus flipped low while an active listing exists.
  if (hasActiveListing && surplusKwh < Number(policy.minSurplusKwh)) {
    return {
      ...base,
      stale: true,
      reason: 'surplus_below_threshold_with_active_listing',
      nodeName: node.name,
      walletAddress: user.walletAddress,
      surplusKwh,
      minSurplusKwh: Number(policy.minSurplusKwh),
      recommendation,
      intent,
      user,
      node,
    };
  }

  if (!recommendation.eligible) {
    return {
      ...base,
      reason: recommendation.reasons?.join('; ') || 'not_eligible',
      nodeName: node.name,
      recommendation,
    };
  }

  if (!recommendation.forecastAvailable) {
    return { ...base, reason: 'no_forecast', nodeName: node.name, recommendation };
  }

  // Quotas (fail-safe: skip when Redis down).
  const usage = await getQuotaUsage(policy._id);
  if (!usage.redisUp) return { ...base, reason: 'redis_unavailable', nodeName: node.name };

  const maxListings = autoConfig.clampMaxListingsPerDay(policy.maxListingsPerDay);
  if (usage.listingsUsed >= maxListings) {
    return { ...base, reason: `daily_listings_cap_reached(${usage.listingsUsed}/${maxListings})`, nodeName: node.name };
  }

  // Min time between decisions.
  const minBetween = autoConfig.clampMinTimeBetweenMs(policy.minTimeBetweenListingsMs);
  const age = await getLastMatchAgeMs(policy._id);
  if (age !== null && age < minBetween) {
    return { ...base, reason: `min_time_between_not_elapsed(${Math.round((minBetween - age) / 1000)}s)`, nodeName: node.name };
  }

  // Price + intent bounds.
  const priced = applyPriceStrategy({ recommendation, policy });
  const bounded = clampToIntentBounds({
    energy: priced.energyAmount,
    unit: priced.unitPriceCc,
    total: priced.totalPriceCc,
    intent,
  });

  // CC daily budget.
  const maxCc = autoConfig.clampMaxTotalCcPerDay(policy.maxTotalCcPerDay);
  if (usage.ccUsed + bounded.totalPriceCc > maxCc) {
    return { ...base, reason: `daily_cc_budget_reached(${round3(usage.ccUsed)}/${round3(maxCc)})`, nodeName: node.name };
  }

  if (bounded.energyAmount < Number(policy.minSurplusKwh)) {
    return { ...base, reason: 'energy_below_min_surplus_after_bounds', nodeName: node.name };
  }

  return {
    ...base,
    matched: true,
    reason: 'matched',
    nodeName: node.name,
    walletAddress: user.walletAddress,
    recommendation,
    intent,
    user,
    node,
    pricing: { ...bounded, strategyReason: priced.reason },
  };
}

/* ------------------------------------------------------------------ */
/* Orchestrator: evaluate all enabled policies                         */
/* ------------------------------------------------------------------ */

/**
 * Run one matcher tick over every enabled policy. Idempotent per policy/hour,
 * fail-closed on kill switch or Redis outage. Returns a summary.
 */
async function evaluateAll({ now = new Date() } = {}) {
  const summary = { evaluated: 0, matched: 0, stale: 0, skipped: 0, errors: 0, reasons: {} };
  const reasons = (r) => {
    summary.reasons[r] = (summary.reasons[r] || 0) + 1;
  };

  if (!(await isAutoTradingActive())) {
    summary.skipped = -1;
    summary.reason = 'kill_switch_off';
    return summary;
  }

  if (!isRedisAvailable()) {
    summary.skipped = -1;
    summary.reason = 'redis_unavailable';
    return summary;
  }

  // Housekeeping: expire stale intents so getActiveIntentForPolicy is correct.
  await listingIntentService.sweepExpiredIntents().catch(() => {});

  const policies = await AutoListingPolicy.find({ enabled: true }).lean();
  summary.totalPolicies = policies.length;

  const ctx = policies.length > 0 ? await buildEvaluationContext(policies, { now }) : null;

  for (const policy of policies) {
    summary.evaluated += 1;

    const owned = await claimJobSlot(policy._id);
    if (!owned) {
      summary.skipped += 1;
      reasons('job_slot_already_claimed');
      continue;
    }

    let decision;
    try {
      decision = await evaluatePolicy(policy, ctx);
    } catch (err) {
      summary.errors += 1;
      reasons('evaluation_error');
      logDecision(policy, { matched: false, reason: 'evaluation_error', error: err.message });
      continue;
    }

    if (decision.matched) {
      summary.matched += 1;
      reasons('matched');
      await handleMatch(policy, decision, now);
    } else if (decision.stale) {
      summary.stale += 1;
      reasons('stale');
      await handleStale(policy, decision, now);
    } else {
      reasons(decision.reason || 'skipped');
    }

    logDecision(policy, decision);
  }

  summary.lastRunAt = new Date().toISOString();
  return summary;
}

/**
 * Act on a matched decision: in v1 (notify-only) send a recommendation
 * notification, record quota usage, and stamp the policy. v2 auto-submit is
 * gated behind isAutoSubmitEnabled + a configured relayer (not in v1).
 */
async function handleMatch(policy, decision, now) {
  const { pricing, recommendation, intent, user, node } = decision;

  await recordQuotaUsage(policy._id, pricing.totalPriceCc);

  await AutoListingPolicy.updateOne(
    { _id: policy._id },
    {
      $set: {
        lastMatchedAt: now,
        lastMatchDecision: {
          matched: true,
          energyAmount: pricing.energyAmount,
          unitPriceCc: pricing.unitPriceCc,
          totalPriceCc: pricing.totalPriceCc,
          strategyReason: pricing.strategyReason,
          recommendationExpiresAt: recommendation.expiresAt,
          intentId: String(intent._id),
          at: now.toISOString(),
          algoVersion: autoConfig.AUTO_TRADING_ALGO_VERSION,
        },
      },
    },
  ).catch(() => {});

  const channels = Array.isArray(policy.notifyChannels) && policy.notifyChannels.length
    ? policy.notifyChannels
    : ['in_app'];

  await notificationService.send({
    userId: policy.userId,
    type: 'auto_listing_recommendation',
    title: `Listing opportunity for ${node.name || 'your node'}`,
    body:
      `Forecast surplus of ${round3(recommendation.surplus?.totalSurplusKwh)} kWh available. ` +
      `Suggested list: ${pricing.energyAmount} units @ ${round6(pricing.unitPriceCc)} CC/unit ` +
      `(${round6(pricing.totalPriceCc)} CC). Confirm in MetaMask to list.`,
    data: {
      policyId: String(policy._id),
      nodeId: String(node._id),
      nodeName: node.name || null,
      energyAmount: pricing.energyAmount,
      unitPriceCc: pricing.unitPriceCc,
      totalPriceCc: pricing.totalPriceCc,
      surplusKwh: recommendation.surplus?.totalSurplusKwh ?? null,
      recommendationExpiresAt: recommendation.expiresAt,
      intentId: String(intent._id),
      notifyOnly: true,
    },
    channels,
    user,
  }).catch(() => {});
}

/**
 * Act on a stale-listing condition (2.3.7): notify the user to consider
 * cancelling their listing. In v1 the actual cancel remains MetaMask-initiated.
 */
async function handleStale(policy, decision, now) {
  const { user, node, surplusKwh } = decision;

  const channels = Array.isArray(policy.notifyChannels) && policy.notifyChannels.length
    ? policy.notifyChannels
    : ['in_app'];

  await AutoListingPolicy.updateOne(
    { _id: policy._id },
    {
      $set: {
        lastMatchedAt: now,
        lastMatchDecision: {
          stale: true,
          surplusKwh: round3(surplusKwh),
          at: now.toISOString(),
          algoVersion: autoConfig.AUTO_TRADING_ALGO_VERSION,
        },
      },
    },
  ).catch(() => {});

  await notificationService.send({
    userId: policy.userId,
    type: 'auto_listing_stale',
    title: `Consider cancelling your listing for ${node.name || 'your node'}`,
    body:
      `Forecast surplus dropped to ${round3(surplusKwh)} kWh, below your ${policy.minSurplusKwh} kWh threshold. ` +
      `Your active listing may no longer match current conditions.`,
    data: {
      policyId: String(policy._id),
      nodeId: String(node._id),
      nodeName: node.name || null,
      surplusKwh: round3(surplusKwh),
    },
    channels,
    user,
  }).catch(() => {});
}

function logDecision(policy, decision) {
  auditService
    .log({
      actor: null,
      action: 'AUTO_MATCH_DECISION',
      resourceType: 'auto_trading',
      resourceId: String(policy._id),
      metadata: {
        matched: Boolean(decision.matched),
        stale: Boolean(decision.stale),
        reason: decision.reason || null,
        energyAmount: decision.pricing?.energyAmount ?? null,
        unitPriceCc: decision.pricing?.unitPriceCc ?? null,
        totalPriceCc: decision.pricing?.totalPriceCc ?? null,
        algoVersion: autoConfig.AUTO_TRADING_ALGO_VERSION,
      },
      req: null,
      severity: decision.matched ? 'info' : 'info',
    })
    .catch((err) => logBackgroundError('autoTrading.auditDecision', err, {
      policyId: String(policy._id),
    }));
}

module.exports = {
  isAutoTradingActive,
  getKillSwitchStatus,
  applyPriceStrategy,
  clampToIntentBounds,
  buildEvaluationContext,
  evaluatePolicy,
  evaluateAll,
  claimJobSlot,
  getQuotaUsage,
  recordQuotaUsage,
};
