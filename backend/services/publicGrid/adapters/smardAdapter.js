const { coerceMw, sumMw, normalizeReading, buildExternalReadingId } = require('./baseAdapter');

/**
 * SMARD adapter — Bundesnetzagentur (Germany). No API key required.
 *
 * Documented contract (https://www.smard.de — open data, CC BY 4.0):
 *   index : GET https://www.smard.de/app/chart_data/{filter}/{region}/index_{resolution}.json
 *           -> { timestamps: [epochMs, ...] }   // available data block start times
 *   data  : GET https://www.smard.de/app/chart_data/{filter}/{region}/{filter}_{ts}_{resolution}.json
 *           -> { timestamps: [epochMs, ...], series: [[value] | null, ...] }
 *
 * `series` and `timestamps` are parallel; a `null` slot means "no data for that
 * 15-min/hour bucket". We take the most recent non-null value per filter.
 *
 * Field mapping (1.5.4): SMARD reports MW at national level.
 *   - generation (sum of `config.generationFilters`) -> energyGenerated
 *   - consumption (`config.consumptionFilter`, total grid load) -> energyConsumed
 *
 * Filter IDs are configurable because SMARD occasionally renumbers them; the
 * defaults below are the commonly-cited renewables + total-load codes. Region
 * defaults to 'DE'.
 */

const HOSTS = ['www.smard.de'];
const BASE = 'https://www.smard.de/app/chart_data';
const RESOLUTION = 'hour';

// Commonly-cited SMARD filter IDs (renewables + total grid load).
const DEFAULT_GENERATION_FILTERS = [410];
const DEFAULT_CONSUMPTION_FILTER = 4100;
const ALLOWED_RESOLUTIONS = ['quarterhour', 'hour', 'day'];

const buildIndexUrl = (filter, region, resolution) =>
  `${BASE}/${filter}/${region}/index_${resolution}.json`;

const buildDataUrl = (filter, region, blockTs, resolution) =>
  `${BASE}/${filter}/${region}/${filter}_${blockTs}_${resolution}.json`;

const validateConfig = (config) => {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  let generationFilters = Array.isArray(cfg.generationFilters)
    ? cfg.generationFilters
    : DEFAULT_GENERATION_FILTERS;
  generationFilters = generationFilters
    .map((f) => parseInt(f, 10))
    .filter((f) => Number.isFinite(f) && f > 0);
  if (generationFilters.length === 0) {
    generationFilters = DEFAULT_GENERATION_FILTERS;
    errors.push('generationFilters must be a non-empty array of positive integers; using default');
  }

  const consumptionFilter = Number.isFinite(parseInt(cfg.consumptionFilter, 10))
    ? parseInt(cfg.consumptionFilter, 10)
    : DEFAULT_CONSUMPTION_FILTER;

  const region = typeof cfg.region === 'string' && /^[A-Z0-9]{2,6}$/.test(cfg.region)
    ? cfg.region
    : 'DE';

  const resolution = ALLOWED_RESOLUTIONS.includes(cfg.resolution)
    ? cfg.resolution
    : RESOLUTION;

  return { ok: true, normalized: { generationFilters, consumptionFilter, region, resolution }, errors };
};

/**
 * Fetch the index for a filter, return the latest block timestamp (epochMs).
 */
const latestBlockTimestamp = async ({ filter, region, resolution, fetch }) => {
  const res = await fetch(buildIndexUrl(filter, region, resolution));
  if (!res.ok) throw new Error(`SMARD index HTTP ${res.status} for filter ${filter}`);
  const json = await res.json();
  const timestamps = Array.isArray(json?.timestamps) ? json.timestamps : null;
  if (!timestamps || timestamps.length === 0) {
    throw new Error(`SMARD index has no data blocks for filter ${filter}`);
  }
  // Newest is the last numeric entry.
  return timestamps.reduce((max, t) => (typeof t === 'number' && t > max ? t : max), 0);
};

/**
 * Fetch one data block and return the most recent { value, timestampMs } pair.
 * Returns null when the block has no usable values.
 */
const latestValueInBlock = async ({ filter, region, blockTs, resolution, fetch }) => {
  const res = await fetch(buildDataUrl(filter, region, blockTs, resolution));
  if (!res.ok) throw new Error(`SMARD data HTTP ${res.status} for filter ${filter}`);
  const json = await res.json();
  const ts = Array.isArray(json?.timestamps) ? json.timestamps : [];
  const series = Array.isArray(json?.series) ? json.series : [];
  if (ts.length === 0) return null;

  for (let i = ts.length - 1; i >= 0; i -= 1) {
    const slot = series[i];
    const raw = Array.isArray(slot) ? slot[0] : slot;
    const mw = coerceMw(raw);
    if (mw !== null && typeof ts[i] === 'number') {
      return { value: mw, timestampMs: ts[i] };
    }
  }
  return null;
};

/**
 * Fetch the latest value for a single filter (index -> block -> last value).
 */
const latestForFilter = async ({ filter, region, resolution, fetch }) => {
  const blockTs = await latestBlockTimestamp({ filter, region, resolution, fetch });
  return latestValueInBlock({ filter, region, blockTs, resolution, fetch });
};

const fetchLatest = async ({ config, fetch }) => {
  const { generationFilters, consumptionFilter, region, resolution } = validateConfig(
    config,
  ).normalized;

  // Fetch the latest value for every generation filter + the consumption filter
  // in parallel. A single filter error is tolerated if at least one yields data.
  const tasks = [
    ...generationFilters.map((f) =>
      latestForFilter({ filter: f, region, resolution, fetch }).catch(() => null),
    ),
    latestForFilter({ filter: consumptionFilter, region, resolution, fetch }).catch(() => null),
  ];

  const results = await Promise.all(tasks);
  const genResults = results.slice(0, generationFilters.length);
  const conResult = results[results.length - 1];

  const generated = sumMw(genResults.map((r) => r?.value));
  const consumed = conResult?.value !== undefined ? coerceMw(conResult.value) : null;

  if (generated === null && consumed === null) {
    throw new Error('SMARD returned no usable data for any configured filter');
  }

  // Use the freshest timestamp among the values that contributed.
  const contributing = [...genResults, conResult].filter(Boolean);
  const timestampMs = contributing.reduce((max, r) => (r.timestampMs > max ? r.timestampMs : max), 0);
  const timestamp = timestampMs > 0 ? new Date(timestampMs) : new Date();

  const normalized = normalizeReading({
    energyGenerated: generated,
    energyConsumed: consumed,
    timestamp,
    externalReadingId: buildExternalReadingId(
      'smard',
      generationFilters.join('+'),
      region,
      timestampMs,
    ),
    unit: 'MW',
  });
  if (!normalized.ok) throw new Error(`SMARD normalize failed: ${normalized.message}`);

  return { readings: [normalized.reading], sourceTimestamp: timestamp };
};

module.exports = {
  providerKey: 'smard_de',
  displayName: 'Germany — SMARD Grid',
  attribution: 'Data: SMARD / Bundesnetzagentur, CC BY 4.0',
  hosts: HOSTS,
  requiresApiKey: false,
  apiKeyEnvVar: null,
  validateConfig,
  fetchLatest,
  DEFAULT_GENERATION_FILTERS,
  DEFAULT_CONSUMPTION_FILTER,
};
