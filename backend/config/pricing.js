/**
 * Pricing engine configuration (Sub-module 2.1).
 *
 * Centralizes every env-driven knob for the forecast-derived kWh price curve so
 * the engine, controller, cache, and tests read one source of truth. All price
 * figures are expressed in "credits per kWh" (cc/kWh), matching the on-chain
 * marketplace unit used by the EnergyTrading contract.
 *
 * Security/guardrail posture (2.1):
 *   - The pricing engine is READ-ONLY: it never touches user wallets, private
 *     keys, or the blockchain write path. It blends forecasts + historical trade
 *     analytics into a *recommendation* curve, nothing more.
 *   - Curves are cached in Redis (default 5-min TTL) to prevent forecast spam
 *     against the AI service from a single client.
 *   - The algorithm is versioned (`PRICING_ALGO_VERSION`); every computed curve
 *     carries that version so downstream UI can render the "prices are
 *     recommendations, not oracle feeds" disclaimer consistently.
 *   - Hard floor/ceiling clamp every output point so a malformed forecast can
 *     never emit a negative or runaway price.
 */

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const toFinite = (value, fallback) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Algorithm versioning — bump when the formula changes. Surfaced on every curve
// so the frontend can adapt and auditors can correlate inputs/outputs.
const PRICING_ALGO_VERSION = '1.0.0';

// Master feature flag. Pricing stays behind `protect` regardless, but this lets
// ops disable the curve endpoint without a deploy.
const isPricingEnabled = () => toBool(process.env.PRICING_ENABLED, true);

// Price bounds in credits per kWh. Hard-clamped after every computation so the
// curve can never return a nonsensical value even with a bad forecast.
const getPriceFloorCc = () =>
  Math.max(0, toFinite(process.env.PRICING_FLOOR_CC, 0.02));

const getPriceCeilingCc = () => {
  const ceiling = toFinite(process.env.PRICING_CEILING_CC, 2.0);
  const floor = getPriceFloorCc();
  return ceiling > floor ? ceiling : floor + 1;
};

// Fallback base price when no historical trade data exists yet (cold start).
const getDefaultBasePriceCc = () => toFinite(process.env.PRICING_DEFAULT_BASE_CC, 0.08);

// How strongly surplus (gen - con) pushes price DOWN. 0.3 => a 100% surplus
// roughly trims 30% off the base price. Clamped to [0, 1] defensively.
const getSurplusCoefficient = () => {
  const c = toFinite(process.env.PRICING_SURPLUS_COEFFICIENT, 0.3);
  return Math.min(1, Math.max(0, c));
};

// Market anchor blend: 70% forecast-implied, 30% historical avgUnitPrice.
// Historical is the realistic floor/ceiling sanity the marketplace has seen.
const getMarketAnchorWeight = () => {
  const w = toFinite(process.env.PRICING_MARKET_ANCHOR_WEIGHT, 0.3);
  return Math.min(1, Math.max(0, w));
};

// Weight (0..1) given to live order-book sell depth when computing combined
// surplus pressure. The EcoPulse marketplace is sell-listing based (no standing
// buy orders), so listed energy acts as additional supply pressure.
const getMarketPressureWeight = () => {
  const w = toFinite(process.env.PRICING_MARKET_PRESSURE_WEIGHT, 0.2);
  return Math.min(1, Math.max(0, w));
};

// Weight (0..1) given to the *live* order-book average asking unit price when
// resolving the market anchor (Sub-module 2.4.1 feedback loop). The book anchor
// is blended with the historical trade average so freshly-listed supply prices
// feed back into recommendations without overwhelming the longer-term signal.
const getOrderBookAnchorWeight = () => {
  const w = toFinite(process.env.PRICING_ORDERBOOK_ANCHOR_WEIGHT, 0.2);
  return Math.min(1, Math.max(0, w));
};

// Confidence band tuning. Bands widen as forecast confidence drops (guardrail
// 2.1.5). BAND_BASE is the minimum half-band even at perfect confidence.
const getBandBase = () => toFinite(process.env.PRICING_BAND_BASE, 0.05);
const getBandUncertaintyScale = () =>
  toFinite(process.env.PRICING_BAND_UNCERTAINTY_SCALE, 0.5);

// Small epsilon so demand is never literally zero in the surplus ratio.
const getMinDemandKwh = () => toFinite(process.env.PRICING_MIN_DEMAND_KWH, 1);

// Curve horizon bounds (hours). Forecasts are daily, so internally we map to
// days, but the public `hours` param is clamped to this range to bound cost.
const MAX_CURVE_HOURS = 168; // 7 days
const MIN_CURVE_HOURS = 1;

// Redis curve cache TTL (seconds). Prevents forecast spam.
const getCacheTtlSeconds = () => toPositiveInt(process.env.PRICING_CACHE_TTL_SECONDS, 300);

// Historical trade lookback for the market anchor (days).
const getHistoricalLookbackDays = () => toPositiveInt(process.env.PRICING_HISTORICAL_LOOKBACK_DAYS, 30);

/* ── Surplus / recommendations (Sub-module 2.2) ─────────────────────── */

// Minimum forecast surplus (kWh over the horizon) required to warrant a listing
// recommendation. Below this the recommendation is returned as ineligible.
const getMinSurplusKwh = () => toFinite(process.env.PRICING_MIN_SURPLUS_KWH, 1);

// Hard cap on recommended energyAmount (kWh). Bounds the suggestion so a
// runaway forecast can never recommend listing an absurd volume.
const getMaxRecommendationKwh = () =>
  toFinite(process.env.PRICING_MAX_RECOMMENDATION_KWH, 10000);

// How long a recommendation stays valid (minutes). Stale recommendations are
// rejected at list time (guardrail 2.2). Default 15 min.
const getRecommendationTtlMinutes = () =>
  toPositiveInt(process.env.PRICING_RECOMMENDATION_TTL_MINUTES, 15);

// Recommendation horizon (hours). How far ahead the surplus window is scanned.
const getRecommendationHorizonHours = () =>
  toPositiveInt(process.env.PRICING_RECOMMENDATION_HORIZON_HOURS, 168);

const clampPrice = (value) => {
  const floor = getPriceFloorCc();
  const ceiling = getPriceCeilingCc();
  if (!Number.isFinite(value)) return floor;
  return Math.min(ceiling, Math.max(floor, value));
};

const clampHours = (hours) => {
  const parsed = parseInt(hours, 10);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(MAX_CURVE_HOURS, Math.max(MIN_CURVE_HOURS, parsed));
};

module.exports = {
  PRICING_ALGO_VERSION,
  isPricingEnabled,
  getPriceFloorCc,
  getPriceCeilingCc,
  getDefaultBasePriceCc,
  getSurplusCoefficient,
  getMarketAnchorWeight,
  getOrderBookAnchorWeight,
  getMarketPressureWeight,
  getBandBase,
  getBandUncertaintyScale,
  getMinDemandKwh,
  getCacheTtlSeconds,
  getHistoricalLookbackDays,
  getMinSurplusKwh,
  getMaxRecommendationKwh,
  getRecommendationTtlMinutes,
  getRecommendationHorizonHours,
  clampPrice,
  clampHours,
  MAX_CURVE_HOURS,
  MIN_CURVE_HOURS,
};
