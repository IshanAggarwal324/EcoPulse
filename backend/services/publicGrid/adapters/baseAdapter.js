/**
 * Base adapter helpers (Sub-module 1.5.2).
 *
 * Every provider adapter implements the same contract so the poller/service can
 * treat them uniformly:
 *
 *   module.exports = {
 *     providerKey, displayName, attribution, hosts: [...],
 *     requiresApiKey, apiKeyEnvVar,
 *     validateConfig(config),           // -> { ok, errors?, normalized? }
 *     fetchLatest({ config, apiKey, fetch }),  // -> { readings: [normalizedReading], sourceTimestamp? }
 *   }
 *
 * A "normalized reading" is a plain object:
 *   { energyGenerated, energyConsumed, timestamp: Date, externalReadingId, unit }
 *
 * All value sanitation / outlier rejection (guardrail 1.5: "reject
 * NaN/negative/outlier values") happens here in `normalizeReading` so every
 * provider gets identical input hygiene regardless of how messy its API is.
 */

const isFiniteNonNegative = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Coerce a provider value into a finite, non-negative MW number, or return null
 * when the value is absent/garbage. Many grid APIs emit `null`, `"-"`, or
 * strings — treat all of those as "no data" rather than 0 so we don't store a
 * bogus zero that flattens the time-series.
 */
const coerceMw = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? null : n;
};

/**
 * Sum an array of provider values (each coerced). Returns null if EVERY value
 * is missing (so an all-null renewables slice becomes "no data", not 0).
 */
const sumMw = (values) => {
  if (!Array.isArray(values) || values.length === 0) return null;
  let total = 0;
  let sawAny = false;
  for (const v of values) {
    const mw = coerceMw(v);
    if (mw !== null) {
      total += mw;
      sawAny = true;
    }
  }
  return sawAny ? total : null;
};

/**
 * Reject NaN / negative / implausibly large values (guardrail 1.5.7). Returns
 * `{ ok, reading?, code?, message? }`. This is the single chokepoint every
 * reading passes through before it touches the ingest pipeline.
 */
const normalizeReading = ({
  energyGenerated,
  energyConsumed,
  timestamp,
  externalReadingId,
  unit = 'MW',
  maxCapacityMw = null,
}) => {
  const gen = coerceMw(energyGenerated);
  const con = coerceMw(energyConsumed);

  if (gen === null && con === null) {
    return { ok: false, code: 'NO_DATA', message: 'reading has no usable generated/consumed value' };
  }

  const generated = gen ?? 0;
  const consumed = con ?? 0;

  // Outlier / sanity ceiling. Uses the source ceiling if provided, else a
  // planetary-scale absolute bound enforced again in the service.
  if (maxCapacityMw !== null && Math.max(generated, consumed) > maxCapacityMw) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      message: `value ${Math.max(generated, consumed)} exceeds ceiling ${maxCapacityMw} MW`,
    };
  }

  let resolvedTs = null;
  if (timestamp !== undefined && timestamp !== null) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, code: 'INVALID_TIMESTAMP', message: 'timestamp is not a valid date' };
    }
    // Reject future-dated grid data (provider bug or clock issue) beyond a day.
    if (date.getTime() - Date.now() > 24 * 3600 * 1000) {
      return { ok: false, code: 'FUTURE_DATED', message: 'reading timestamp is in the future' };
    }
    resolvedTs = date;
  }

  if (!externalReadingId || typeof externalReadingId !== 'string') {
    return { ok: false, code: 'MISSING_EXTERNAL_ID', message: 'externalReadingId is required for dedup' };
  }

  return {
    ok: true,
    reading: {
      energyGenerated: generated,
      energyConsumed: consumed,
      timestamp: resolvedTs,
      externalReadingId: externalReadingId.slice(0, 200),
      unit: unit === 'MW' ? 'MW' : 'kW',
    },
  };
};

/**
 * Build a stable, secret-free dedup id from provider-native parts. Joined with
 * ':' and capped. Never include API keys here.
 */
const buildExternalReadingId = (...parts) =>
  parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => String(p).trim())
    .join(':')
    .slice(0, 200);

module.exports = {
  isFiniteNonNegative,
  coerceMw,
  sumMw,
  normalizeReading,
  buildExternalReadingId,
};
