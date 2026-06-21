/**
 * Surplus detection & listing recommendations (Sub-module 2.2).
 *
 * Sits on top of the pricing engine curve (2.1) to answer: "given this node's
 * forecast, how much surplus energy should I list, and at what price?" The
 * service is READ-ONLY and never touches wallets or the chain — it produces a
 * short-lived *recommendation* that the user explicitly confirms in MetaMask.
 *
 * Guardrails (2.2):
 *   - Node ownership is enforced in the controller (user.userId === node.userId);
 *     admin may view any node. This service trusts the controller's scoping.
 *   - `validUntil` is a short TTL (15 min default). Stale recommendations must be
 *     rejected at list time — the returned `expiresAt` lets the UI enforce this.
 *   - Eligibility gates (node active, surplus >= MIN_SURPLUS_KWH, no duplicate
 *     active listing) are surfaced as an explicit `eligible` flag + `reason`.
 *   - energyAmount is hard-capped so a runaway forecast can't suggest a
 *     nonsensical volume.
 */

const config = require('../../config/pricing');
const pricingEngine = require('./pricingEngine');

const HOUR_MS = 3600 * 1000;

/**
 * Hours spanned by a single forecast point, inferred from adjacent timestamps.
 * Falls back to 24h (daily forecast) when timestamps are missing/uniform.
 */
function hoursPerPoint(prevTs, ts, nextTs) {
  let span = null;
  if (nextTs && ts) {
    span = (new Date(nextTs).getTime() - new Date(ts).getTime()) / HOUR_MS;
  } else if (ts && prevTs) {
    span = (new Date(ts).getTime() - new Date(prevTs).getTime()) / HOUR_MS;
  }
  return Number.isFinite(span) && span > 0 ? span : 24;
}

/**
 * Pure: integrate surplus over the pricing curve points where gen > con.
 *
 * @param {Array} points  pricing curve points ({ timestamp, surplusKw, pricePerKwhCc, hasForecast }).
 * @returns {object} { totalSurplusKwh, surplusPointCount, peakSurplusKw, weightedAvgPriceCc, windows }
 */
function computeSurplus(points) {
  const safePoints = Array.isArray(points) ? points : [];
  let totalSurplusKwh = 0;
  let weightedPriceSum = 0;
  let weightedEnergySum = 0;
  let peakSurplusKw = 0;
  let surplusPointCount = 0;
  const windows = [];

  for (let i = 0; i < safePoints.length; i++) {
    const p = safePoints[i];
    if (!p || p.hasForecast === false) continue;
    const surplusKw = Number(p.surplusKw);
    if (!Number.isFinite(surplusKw) || surplusKw <= 0) continue;

    const span = hoursPerPoint(
      safePoints[i - 1]?.timestamp,
      p.timestamp,
      safePoints[i + 1]?.timestamp,
    );
    const energyKwh = surplusKw * span;
    totalSurplusKwh += energyKwh;
    surplusPointCount += 1;
    if (surplusKw > peakSurplusKw) peakSurplusKw = surplusKw;

    const price = Number(p.pricePerKwhCc);
    if (Number.isFinite(price)) {
      weightedPriceSum += price * energyKwh;
      weightedEnergySum += energyKwh;
    }

    // Merge into a contiguous surplus window.
    const last = windows[windows.length - 1];
    if (last && p.timestamp && last.endIndex === i - 1) {
      last.endIndex = i;
      last.energyKwh += energyKwh;
      last.endTimestamp = p.timestamp;
    } else {
      windows.push({
        startIndex: i,
        endIndex: i,
        startTimestamp: p.timestamp,
        endTimestamp: p.timestamp,
        energyKwh,
      });
    }
  }

  const weightedAvgPriceCc =
    weightedEnergySum > 0 ? weightedPriceSum / weightedEnergySum : null;

  return {
    totalSurplusKwh,
    surplusPointCount,
    peakSurplusKw,
    weightedAvgPriceCc,
    windows,
  };
}

/**
 * Count the user's currently-active marketplace listings (duplicate guard).
 * Returns 0 when the chain/marketplace is unavailable so a transient outage
 * never blocks a recommendation entirely.
 */
async function getActiveListingCount(walletAddress) {
  if (!walletAddress) return 0;
  const counts = await getActiveListingCountsByWallet([walletAddress]);
  return counts.get(String(walletAddress).toLowerCase()) ?? 0;
}

/**
 * Count active listings per seller wallet in one chain scan (H22 batching).
 *
 * @param {string[]} walletAddresses
 * @returns {Promise<Map<string, number>>} lowercased wallet -> count
 */
async function getActiveListingCountsByWallet(walletAddresses) {
  const map = new Map();
  const normalized = [
    ...new Set(
      (walletAddresses || [])
        .filter(Boolean)
        .map((w) => String(w).toLowerCase()),
    ),
  ];
  for (const w of normalized) map.set(w, 0);
  if (normalized.length === 0) return map;

  try {
    const BlockchainService = require('../blockchainService');
    const listings = await BlockchainService.getActiveListings();
    for (const listing of listings) {
      const seller = String(listing.seller || '').toLowerCase();
      if (map.has(seller)) {
        map.set(seller, map.get(seller) + 1);
      }
    }
  } catch {
    // Degrade to zero counts — same posture as getActiveListingCount.
  }
  return map;
}

/**
 * Build a listing recommendation for a node.
 *
 * @param {object} opts
 * @param {object} opts.node           EnergyNode doc (lean) — must include status/name.
 * @param {object} opts.user           User doc (lean) — must include walletAddress.
 * @param {number} opts.hours          Horizon override (clamped).
 * @returns {Promise<object>} Recommendation payload.
 */
async function buildRecommendation({ node, user, hours, activeListingCount } = {}) {
  const horizon = config.clampHours(hours || config.getRecommendationHorizonHours());

  const curve = await pricingEngine.getPricingCurve({ nodeId: String(node._id), hours: horizon });
  const surplus = computeSurplus(curve.points);

  const resolvedListingCount =
    activeListingCount !== undefined && activeListingCount !== null
      ? Number(activeListingCount) || 0
      : await getActiveListingCount(user?.walletAddress);

  // Eligibility (guardrail 2.2.2).
  const reasons = [];
  if (node.status !== 'active') reasons.push(`node is ${node.status || 'inactive'}`);
  if (surplus.totalSurplusKwh < config.getMinSurplusKwh()) reasons.push('insufficient forecast surplus');
  if (resolvedListingCount > 0) {
    reasons.push(`${resolvedListingCount} active listing(s) already open`);
  }

  const eligible = reasons.length === 0;

  // Recommended amount is the forecast surplus, hard-capped.
  const rawAmount = surplus.totalSurplusKwh;
  const energyAmount = Math.min(
    config.getMaxRecommendationKwh(),
    Math.max(0, rawAmount),
  );

  // Unit price: surplus-weighted average from the curve, else the curve base.
  const unitPrice =
    surplus.weightedAvgPriceCc !== null
      ? surplus.weightedAvgPriceCc
      : curve.basePriceCc;

  const clampedUnit = config.clampPrice(unitPrice);
  const totalPriceCc = config.clampPrice(energyAmount * clampedUnit);

  const ttlMs = config.getRecommendationTtlMinutes() * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  return {
    nodeId: String(node._id),
    nodeName: node.name || null,
    hours: horizon,
    eligible,
    reasons,
    energyAmount: Math.round(energyAmount * 1000) / 1000,
    unitPriceCc: Math.round(clampedUnit * 1e6) / 1e6,
    totalPriceCc: Math.round(totalPriceCc * 1e6) / 1e6,
    surplus: {
      totalSurplusKwh: Math.round(surplus.totalSurplusKwh * 1000) / 1000,
      peakSurplusKw: Math.round(surplus.peakSurplusKw * 1000) / 1000,
      surplusPointCount: surplus.surplusPointCount,
      windowCount: surplus.windows.length,
    },
    market: {
      activeListingCount: resolvedListingCount,
      basePriceCc: curve.basePriceCc,
      marketDepthKw: curve.marketDepthKw,
    },
    forecastAvailable: curve.forecastAvailable,
    algoVersion: config.PRICING_ALGO_VERSION,
    expiresAt,
    disclaimer:
      'Recommendation based on forecast; not guaranteed. The marketplace ' +
      'contract is the source of truth for executed prices.',
  };
}

module.exports = {
  computeSurplus,
  buildRecommendation,
  getActiveListingCount,
  getActiveListingCountsByWallet,
  hoursPerPoint,
};
