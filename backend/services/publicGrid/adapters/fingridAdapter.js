const { coerceMw, sumMw, normalizeReading, buildExternalReadingId } = require('./baseAdapter');

/**
 * Fingrid adapter — Finnish transmission system operator open data.
 * ~3-minute updates. Requires a free `FINGRID_API_KEY` (https://data.fingrid.fi).
 *
 * Contract:
 *   GET https://data.fingrid.fi/api/datasets/{datasetId}/data
 *       header: x-api-key (key stays out of the URL/logs)
 *       query : startTime={iso}&endTime={iso}&format=json&oneRow=true
 *   -> { data: [{ value, startTime, endTime }] }
 *
 * Each dataset is one physical series; the adapter sums the configured
 * generation datasets and reads the single configured consumption dataset.
 * Dataset IDs are configurable because Fingrid reorganizes them; defaults are
 * commonly-cited wind/solar/hydro + consumption codes.
 *
 * Field mapping (1.5.4): MW.
 */

const HOSTS = ['data.fingrid.fi'];
const BASE = 'https://data.fingrid.fi/api/datasets';

const DEFAULT_GENERATION_DATASETS = [74, 247, 53]; // wind, solar, hydro
const DEFAULT_CONSUMPTION_DATASET = 193; // total consumption (verify against catalog)
const WINDOW_MINUTES = 30; // look back 30 min for the latest point

const validateConfig = (config) => {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  const generationDatasets =
    Array.isArray(cfg.generationDatasets) && cfg.generationDatasets.length
      ? cfg.generationDatasets
          .map((id) => parseInt(id, 10))
          .filter((id) => Number.isFinite(id) && id > 0)
      : DEFAULT_GENERATION_DATASETS;

  const consumptionDataset = Number.isFinite(parseInt(cfg.consumptionDataset, 10))
    ? parseInt(cfg.consumptionDataset, 10)
    : DEFAULT_CONSUMPTION_DATASET;

  return { ok: true, normalized: { generationDatasets, consumptionDataset }, errors };
};

const isoWindow = (minutes) => {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
};

const fetchDatasetLatest = async ({ datasetId, fetch, apiKey }) => {
  if (!apiKey) throw new Error('Fingrid requires an API key (FINGRID_API_KEY)');
  const { startIso, endIso } = isoWindow(WINDOW_MINUTES);
  const url = `${BASE}/${datasetId}/data?startTime=${encodeURIComponent(
    startIso,
  )}&endTime=${encodeURIComponent(endIso)}&format=json`;

  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    const detail = res.status === 401 || res.status === 403 ? ' (invalid/missing API key)' : '';
    throw new Error(`Fingrid HTTP ${res.status} for dataset ${datasetId}${detail}`);
  }
  const json = await res.json();
  const rows = json?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[rows.length - 1];
  const mw = coerceMw(row?.value);
  if (mw === null) return null;
  const ts = row?.endTime || row?.startTime ? new Date(row.endTime || row.startTime) : null;
  return { value: mw, timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : new Date() };
};

const fetchLatest = async ({ config, apiKey, fetch }) => {
  const { generationDatasets, consumptionDataset } = validateConfig(config).normalized;

  const tasks = [
    ...generationDatasets.map((id) =>
      fetchDatasetLatest({ datasetId: id, fetch, apiKey }).catch(() => null),
    ),
    fetchDatasetLatest({ datasetId: consumptionDataset, fetch, apiKey }).catch(() => null),
  ];
  const results = await Promise.all(tasks);

  const genResults = results.slice(0, generationDatasets.length);
  const conResult = results[results.length - 1];

  const generated = sumMw(genResults.map((r) => r?.value));
  const consumed = conResult?.value !== undefined ? coerceMw(conResult.value) : null;

  if (generated === null && consumed === null) throw new Error('Fingrid returned no usable data');

  const contributing = [...genResults, conResult].filter(Boolean);
  const timestamp = contributing.reduce(
    (max, r) => (r.timestamp && r.timestamp > max ? r.timestamp : max),
    new Date(0),
  );

  const normalized = normalizeReading({
    energyGenerated: generated,
    energyConsumed: consumed,
    timestamp,
    externalReadingId: buildExternalReadingId(
      'fingrid',
      generationDatasets.join('+'),
      timestamp.toISOString(),
    ),
    unit: 'MW',
  });
  if (!normalized.ok) throw new Error(`Fingrid normalize failed: ${normalized.message}`);

  return { readings: [normalized.reading], sourceTimestamp: timestamp };
};

module.exports = {
  providerKey: 'fingrid_fi',
  displayName: 'Finland — Fingrid Grid',
  attribution: 'Data: Fingrid Data Hub, CC BY 4.0',
  hosts: HOSTS,
  requiresApiKey: true,
  apiKeyEnvVar: 'FINGRID_API_KEY',
  validateConfig,
  fetchLatest,
  DEFAULT_GENERATION_DATASETS,
};
