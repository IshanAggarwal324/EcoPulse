/**
 * Auto-trading marketplace feedback analytics (Sub-module 2.4.4).
 *
 * Surfaces the closed-loop quality metrics the admin dashboard needs:
 *
 *   1. Forecast-to-list conversion rate — of the recommendations the matcher
 *      issued, what fraction actually became on-chain listings (via the signed
 *      ListingIntent being consumed by a post-list validation link).
 *   2. Average recommendation accuracy — how close the matcher's recommended
 *      unit price was to the realized on-chain listing unit price (1 - MAPE).
 *   3. Listing-volume anomaly detection (2.4 guardrail: "Monitor for anomalous
 *      listing volume (fraud alert)") — flags a day whose listing count exceeds
 *      the trailing mean + N standard deviations.
 *
 * All metrics degrade gracefully to zero/neutral when underlying collections are
 * empty (cold start) so the dashboard never renders NaN.
 */

const AuditLog = require('../../models/AuditLog');
const Trade = require('../../models/Trade');
const ListingIntent = require('../../models/ListingIntent');
const AutoListingPolicy = require('../../models/AutoListingPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;

const toFinite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);
const clamp01 = (n) => Math.min(1, Math.max(0, toFinite(n)));

/**
 * Forecast-to-list conversion rate over a lookback window.
 *
 *   recommendationsIssued = matcher decisions that produced a recommendation
 *     (AuditLog AUTO_MATCH_DECISION with metadata.matched === true).
 *   listingsFromAuto = ListingIntents consumed by a post-list validation link
 *     (the on-chain listing authorized by a signed intent).
 *
 * Conversion = listingsFromAuto / max(recommendationsIssued, 1), clamped to [0,1].
 */
async function getConversionMetrics({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * DAY_MS);

  const [matchedDecisions, consumedIntents, totalListings] = await Promise.all([
    AuditLog.countDocuments({
      action: 'AUTO_MATCH_DECISION',
      'metadata.matched': true,
      createdAt: { $gte: since },
    }).catch(() => 0),
    ListingIntent.countDocuments({
      status: 'consumed',
      consumedAt: { $gte: since },
    }).catch(() => 0),
    Trade.countDocuments({ eventType: 'listed', blockTimestamp: { $gte: since } }).catch(() => 0),
  ]);

  const rate = matchedDecisions > 0 ? consumedIntents / matchedDecisions : null;

  return {
    recommendationsIssued: matchedDecisions,
    listingsFromAutoTrading: consumedIntents,
    totalOnChainListings: totalListings,
    conversionRate: rate !== null ? clamp01(rate) : null,
    // Raw ratio (may exceed 1 if a manual listing consumed an intent without a
    // matching recommendation record) surfaced for operator diagnostics.
    conversionRatioRaw: matchedDecisions > 0 ? toFinite(consumedIntents / matchedDecisions) : null,
    sinceDays,
  };
}

/**
 * Average recommendation accuracy (1 - MAPE) between the matcher's recommended
 * unit price and the realized on-chain listing unit price.
 *
 * Pairs are built from consumed intents (which carry the realized
 * consumedListingId/txHash) joined to:
 *   - the recommending policy's lastMatchDecision.unitPriceCc (recommended), and
 *   - the indexed `listed` Trade for that listing (realized unit = price/energy).
 *
 * Only pairs where both sides are present and positive are scored, so a cold
 * start or a missing audit trail degrades to `accuracyScore: null`.
 */
async function getRecommendationAccuracy({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * DAY_MS);

  const consumed = await ListingIntent.find({
    status: 'consumed',
    consumedAt: { $gte: since },
    consumedListingId: { $ne: null },
    policyId: { $ne: null },
  })
    .select('policyId consumedListingId consumedTxHash')
    .lean()
    .catch(() => []);

  if (consumed.length === 0) {
    return { accuracyScore: null, samples: 0, meanAbsPctError: null, sinceDays };
  }

  const policyIds = [...new Set(consumed.map((c) => String(c.policyId)))];
  const listingIds = [...new Set(consumed.map((c) => Number(c.consumedListingId)))];

  const [policies, trades] = await Promise.all([
    AutoListingPolicy.find({ _id: { $in: policyIds } })
      .select('_id lastMatchDecision')
      .lean()
      .catch(() => []),
    Trade.find({
      eventType: 'listed',
      listingId: { $in: listingIds },
    })
      .select('listingId energyAmount price')
      .lean()
      .catch(() => []),
  ]);

  const policyById = new Map(policies.map((p) => [String(p._id), p]));
  // Prefer the most recent listed event per listingId for the realized price.
  const tradeByListing = new Map();
  for (const t of trades) {
    tradeByListing.set(Number(t.listingId), t);
  }

  let sumAbsPctError = 0;
  let samples = 0;

  for (const c of consumed) {
    const policy = policyById.get(String(c.policyId));
    const recommended = Number(policy?.lastMatchDecision?.unitPriceCc);
    const trade = tradeByListing.get(Number(c.consumedListingId));
    if (!trade) continue;
    const energy = Number(trade.energyAmount) || 0;
    const totalPrice = parseFloat(trade.price) || 0;
    if (energy <= 0) continue;
    const realized = totalPrice / energy;
    if (!Number.isFinite(recommended) || recommended <= 0) continue;
    if (!Number.isFinite(realized) || realized <= 0) continue;

    const absPctError = Math.abs(realized - recommended) / recommended;
    if (Number.isFinite(absPctError)) {
      sumAbsPctError += Math.min(absPctError, 10); // cap outlier influence
      samples += 1;
    }
  }

  if (samples === 0) {
    return { accuracyScore: null, samples: 0, meanAbsPctError: null, sinceDays };
  }

  const mape = sumAbsPctError / samples;
  return {
    accuracyScore: clamp01(1 - mape),
    samples,
    meanAbsPctError: toFinite(mape),
    sinceDays,
  };
}

/**
 * Listing-volume anomaly detection (2.4 guardrail). Compares today's listing
 * count against the trailing baseline mean + sensitivity*std. Flags a potential
 * fraud / burst when exceeded.
 */
async function getListingVolumeAnomaly({
  baselineDays = 14,
  sensitivity = 3,
} = {}) {
  const now = Date.now();
  const startOfToday = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  const baselineStart = new Date(startOfToday.getTime() - baselineDays * DAY_MS);

  const rows = await Trade.aggregate([
    { $match: { eventType: 'listed', blockTimestamp: { $gte: baselineStart } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$blockTimestamp' } },
        count: { $sum: 1 },
      },
    },
  ]).catch(() => []);

  const todayKey = startOfToday.toISOString().slice(0, 10);
  let todayCount = 0;
  const baselineCounts = [];
  for (const r of rows) {
    if (r._id === todayKey) {
      todayCount = toFinite(r.count);
    } else {
      baselineCounts.push(toFinite(r.count));
    }
  }

  if (baselineCounts.length === 0) {
    return {
      isAnomalous: false,
      reason: 'insufficient_baseline',
      todayCount,
      baselineMean: null,
      threshold: null,
      sensitivity,
      baselineDays,
    };
  }

  const mean = baselineCounts.reduce((a, b) => a + b, 0) / baselineCounts.length;
  const variance =
    baselineCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / baselineCounts.length;
  const std = Math.sqrt(variance);
  const threshold = mean + sensitivity * std;

  const isAnomalous = todayCount > threshold && todayCount > 0;

  return {
    isAnomalous,
    reason: isAnomalous
      ? `listing_volume_exceeds_baseline_${sensitivity}sigma`
      : 'within_baseline',
    todayCount,
    baselineMean: toFinite(mean),
    baselineStd: toFinite(std),
    threshold: toFinite(threshold),
    sensitivity,
    baselineDays,
  };
}

/**
 * Aggregate the full analytics payload for the admin dashboard.
 */
async function getAutoTradingAnalytics({ sinceDays = 30 } = {}) {
  const [conversion, accuracy, anomaly, policySummary] = await Promise.all([
    getConversionMetrics({ sinceDays }),
    getRecommendationAccuracy({ sinceDays }),
    getListingVolumeAnomaly(),
    Promise.all([
      AutoListingPolicy.countDocuments({ enabled: true }),
      AutoListingPolicy.countDocuments({}),
      ListingIntent.countDocuments({ status: 'active' }),
      ListingIntent.countDocuments({ status: 'consumed' }),
      ListingIntent.countDocuments({ status: 'expired' }),
      ListingIntent.countDocuments({ status: 'revoked' }),
    ]).then(([enabledPolicies, totalPolicies, activeI, consumedI, expiredI, revokedI]) => ({
      policies: { enabled: enabledPolicies, total: totalPolicies },
      intents: { active: activeI, consumed: consumedI, expired: expiredI, revoked: revokedI },
    })),
  ]);

  return {
    conversion,
    recommendationAccuracy: accuracy,
    listingVolumeAnomaly: anomaly,
    summary: policySummary,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getAutoTradingAnalytics,
  getConversionMetrics,
  getRecommendationAccuracy,
  getListingVolumeAnomaly,
};
