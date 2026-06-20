/**
 * Pricing engine (Sub-module 2.1).
 *
 * Turns LSTM forecast output + historical marketplace analytics into a kWh
 * price curve (credits per kWh). The engine is READ-ONLY — it never accesses
 * wallets, private keys, or the blockchain write path. Curves are
 * *recommendations* surfaced to the UI; the on-chain marketplace remains the
 * single source of truth for executed prices.
 *
 * Formula (v1, see config.PRICING_ALGO_VERSION):
 *   basePrice       = historicalAvgUnitPrice || DEFAULT_BASE  (market anchor)
 *   surplusRatio    = (forecastGen - forecastCon) / max(forecastCon, MIN_DEMAND)
 *   marketSurplus   = listedEnergyKw / max(forecastGen + listedEnergyKw, 1)
 *   combinedSurplus = clamp(surplusRatio*(1-MARKET_PRESSURE) + marketSurplus*MARKET_PRESSURE, -1, 2)
 *   hourlyPrice     = clamp(basePrice * (1 - SURPLUS_COEFF * combinedSurplus), floor, ceiling)
 *
 * Confidence bands widen as forecast confidence falls (guardrail 2.1.5).
 *
 * Guardrails implemented here:
 *   - NaN / negative / non-finite forecast values are rejected and treated as
 *     no-data (a malformed forecast can never produce a NaN or negative price).
 *   - Every output price is hard-clamped to [floor, ceiling].
 *   - Curves are Redis-cached (5-min default) to prevent forecast spam.
 *   - Audit-friendly: buildPricingCurve returns the full input snapshot.
 */

const config = require('../../config/pricing');
const { getRedisClient, isRedisAvailable } = require('../../config/redis');
const { getTradeStats } = require('../analytics/tradeAnalytics');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !INTERNAL_SERVICE_API_KEY) {
  throw new Error('INTERNAL_SERVICE_API_KEY must be set in production');
}

const CACHE_PREFIX = 'pricing:curve';

/* ------------------------------------------------------------------ */
/* Pure pricing math (unit-tested, no I/O)                             */
/* ------------------------------------------------------------------ */

const safeNumber = (value) => {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Compute the forecast surplus ratio for a single prediction point.
 * Returns null when either side is missing/invalid (no-data, not zero).
 */
function computeSurplusRatio(forecastGen, forecastCon) {
  const gen = safeNumber(forecastGen);
  const con = safeNumber(forecastCon);
  if (gen === null || con === null) return null;
  const demand = Math.max(con, config.getMinDemandKwh());
  return (gen - con) / demand;
}

/**
 * Blend forecast-implied price with the historical market anchor
 * (guardrail 2.1.4 — 70/30 weighted by default).
 */
function blendMarketAnchor(forecastImpliedPrice, historicalAvgUnitPrice) {
  const anchor = safeNumber(historicalAvgUnitPrice);
  const implied = safeNumber(forecastImpliedPrice);
  const weight = config.getMarketAnchorWeight();

  if (anchor !== null && implied !== null) {
    return implied * (1 - weight) + anchor * weight;
  }
  if (anchor !== null) return anchor;
  if (implied !== null) return implied;
  return config.getDefaultBasePriceCc();
}

/**
 * Map a forecast point + market depth into a raw (pre-clamp) price and surplus.
 */
function computePricePoint({ forecastGen, forecastCon, historicalAvgUnitPrice, listedEnergyKw }) {
  const basePrice = blendMarketAnchor(config.getDefaultBasePriceCc(), historicalAvgUnitPrice);
  const surplusRatio = computeSurplusRatio(forecastGen, forecastCon);

  // No usable forecast -> fall back to anchored base price, neutral surplus.
  if (surplusRatio === null) {
    return { price: basePrice, surplusKw: 0, surplusRatio: 0, hasForecast: false };
  }

  const gen = safeNumber(forecastGen);
  const listed = safeNumber(listedEnergyKw) || 0;
  const marketSurplus = gen + listed > 0 ? listed / (gen + listed) : 0;

  const pressureWeight = config.getMarketPressureWeight();
  const combinedSurplus = Math.min(
    2,
    Math.max(-1, surplusRatio * (1 - pressureWeight) + marketSurplus * pressureWeight)
  );

  const coeff = config.getSurplusCoefficient();
  const price = basePrice * (1 - coeff * combinedSurplus);
  const surplusKw = Math.max(0, gen - (safeNumber(forecastCon) || 0));

  return { price, surplusKw, surplusRatio: combinedSurplus, hasForecast: true };
}

/**
 * Confidence bands widen as forecast confidence drops (guardrail 2.1.5).
 */
function buildConfidenceBands(price, confidence) {
  const conf = Math.min(1, Math.max(0, safeNumber(confidence) ?? 0.5));
  const uncertainty = 1 - conf;
  const halfBand = config.getBandBase() + uncertainty * config.getBandUncertaintyScale();
  return {
    confidenceLow: config.clampPrice(price * (1 - halfBand)),
    confidenceHigh: config.clampPrice(price * (1 + halfBand)),
  };
}

/* ------------------------------------------------------------------ */
/* Data fetchers (I/O)                                                 */
/* ------------------------------------------------------------------ */

function buildInternalHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
  };
}

/**
 * Historical avg unit price from completed marketplace purchases over the
 * configured lookback. Falls back to null (cold start) when no trades exist.
 */
async function getHistoricalAvgUnitPrice() {
  try {
    const stats = await getTradeStats();
    const volume = Number.isFinite(stats.totalVolumeCredits) ? stats.totalVolumeCredits : 0;
    const energy = Number.isFinite(stats.totalEnergyTraded) ? stats.totalEnergyTraded : 0;
    if (energy <= 0) return null;
    return volume / energy;
  } catch {
    return null;
  }
}

/**
 * Live sell-side order book depth (kWh). The EcoPulse marketplace has no
 * standing buy orders, so listed energy acts as additional supply pressure on
 * price. Returns 0 if the chain/marketplace is unavailable.
 */
async function getMarketDepthKw() {
  try {
    // Lazy require to avoid loading ethers/blockchain in the pure-math path
    // and to keep the unit tests free of chain coupling.
    const { getActiveOrders } = require('../marketplaceService');
    const { summary } = await getActiveOrders({ limit: 100 });
    return Number.isFinite(summary?.totalEnergy) ? summary.totalEnergy : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch the LSTM forecast curve from the AI service for a node (or aggregate).
 * Uses the same POST /forecast/ contract as forecastController.
 */
async function fetchForecastCurve({ nodeId = null, days = 7 } = {}) {
  const body = { days_to_predict: days, use_dummy_data: false };
  if (nodeId) body.node_id = nodeId;

  let response;
  try {
    response = await fetch(`${AI_SERVICE_URL}/forecast/`, {
      method: 'POST',
      headers: buildInternalHeaders(),
      body: JSON.stringify(body),
    });
  } catch {
    return { predictions: [], available: false };
  }

  if (!response.ok) return { predictions: [], available: false };

  const data = await response.json();
  const predictions = Array.isArray(data.predictions) ? data.predictions : [];
  return { predictions, available: true, modelStatus: data.model_status || null };
}

/* ------------------------------------------------------------------ */
/* Curve assembly                                                      */
/* ------------------------------------------------------------------ */

function normalizePrediction(pred) {
  return {
    timestamp: pred.timestamp || pred.time || null,
    forecastGen: pred.predicted_generation ?? pred.generation ?? null,
    forecastCon: pred.predicted_consumption ?? pred.consumption ?? null,
    confidence: pred.confidence ?? null,
  };
}

/**
 * Build the full pricing curve. Pure with respect to its arguments (the I/O is
 * done by the caller via fetchForecastCurve / analytics) so it is unit-testable.
 */
function buildPricingCurve({ predictions, historicalAvgUnitPrice, listedEnergyKw }) {
  const curve = (predictions || []).map((raw) => {
    const p = normalizePrediction(raw);
    const { price, surplusKw, surplusRatio, hasForecast } = computePricePoint({
      forecastGen: p.forecastGen,
      forecastCon: p.forecastCon,
      historicalAvgUnitPrice,
      listedEnergyKw,
    });
    const clamped = config.clampPrice(price);
    const bands = buildConfidenceBands(clamped, p.confidence);
    return {
      timestamp: p.timestamp,
      pricePerKwhCc: clamped,
      confidenceLow: bands.confidenceLow,
      confidenceHigh: bands.confidenceHigh,
      surplusKw: Math.round(surplusKw * 1000) / 1000,
      surplusRatio: Math.round(surplusRatio * 1000) / 1000,
      hasForecast,
    };
  });

  return curve;
}

/* ------------------------------------------------------------------ */
/* Cache (Redis, graceful fallback)                                    */
/* ------------------------------------------------------------------ */

function cacheKey({ nodeId, hours }) {
  return nodeId ? `${CACHE_PREFIX}:${nodeId}:${hours}` : `${CACHE_PREFIX}:aggregate:${hours}`;
}

async function readCache(key) {
  if (!isRedisAvailable()) return null;
  const client = getRedisClient();
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  if (!isRedisAvailable()) return;
  const client = getRedisClient();
  try {
    await client.set(key, JSON.stringify(value), 'EX', config.getCacheTtlSeconds());
  } catch {
    // cache is best-effort
  }
}

/* ------------------------------------------------------------------ */
/* Public orchestrator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute (or return cached) pricing curve for a node or the grid aggregate.
 *
 * @param {object} opts
 * @param {string|null} opts.nodeId  ObjectId string or null for grid aggregate.
 * @param {number} opts.hours        Requested horizon (clamped to [1,168]).
 * @param {boolean} opts.bypassCache Skip the Redis cache (e.g. admin refresh).
 * @returns {Promise<object>} Curve response payload.
 */
async function getPricingCurve({ nodeId = null, hours = 24, bypassCache = false } = {}) {
  const clampedHours = config.clampHours(hours);
  const days = Math.max(1, Math.ceil(clampedHours / 24));
  const key = cacheKey({ nodeId, hours: clampedHours });

  if (!bypassCache) {
    const cached = await readCache(key);
    if (cached) return { ...cached, cached: true };
  }

  const [historicalAvgUnitPrice, listedEnergyKw, forecast] = await Promise.all([
    getHistoricalAvgUnitPrice(),
    getMarketDepthKw(),
    fetchForecastCurve({ nodeId, days }),
  ]);

  const curve = buildPricingCurve({
    predictions: forecast.predictions,
    historicalAvgUnitPrice,
    listedEnergyKw,
  });

  const payload = {
    nodeId: nodeId || null,
    hours: clampedHours,
    points: curve,
    algoVersion: config.PRICING_ALGO_VERSION,
    basePriceCc:
      historicalAvgUnitPrice !== null
        ? historicalAvgUnitPrice
        : config.getDefaultBasePriceCc(),
    marketDepthKw: listedEnergyKw,
    forecastAvailable: forecast.available,
    modelStatus: forecast.modelStatus || null,
    bounds: {
      floorCc: config.getPriceFloorCc(),
      ceilingCc: config.getPriceCeilingCc(),
    },
    disclaimer:
      'Prices are forecast-derived recommendations, not on-chain oracle feeds. ' +
      'The marketplace contract is the source of truth for executed prices.',
    computedAt: new Date().toISOString(),
  };

  await writeCache(key, payload);

  return { ...payload, cached: false };
}

module.exports = {
  // Orchestrator
  getPricingCurve,
  // Pure math (exported for tests + surplus service in 2.2)
  computePricePoint,
  computeSurplusRatio,
  blendMarketAnchor,
  buildConfidenceBands,
  buildPricingCurve,
  normalizePrediction,
  // Data fetchers
  getHistoricalAvgUnitPrice,
  getMarketDepthKw,
  fetchForecastCurve,
  // Cache helpers (exported for tests)
  readCache,
  writeCache,
  cacheKey,
};
