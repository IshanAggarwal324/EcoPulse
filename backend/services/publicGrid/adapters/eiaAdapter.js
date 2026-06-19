const { coerceMw, normalizeReading, buildExternalReadingId } = require('./baseAdapter');

/**
 * EIA adapter — U.S. Energy Information Administration open data.
 * Hourly net generation + demand by balancing authority. Requires a free
 * `EIA_API_KEY` (https://www.eia.gov/opendata/).
 *
 * v2 contract:
 *   GET https://api.eia.gov/v2/electricity/rto/region-data/data/
 *     header: X-Api-Key (key stays out of the URL/logs)
 *     query : frequency=hourly&data[0]=value&facets[respondent][]={ba}
 *             &facets[type][]={NG|D}&sort[0][column]=period&sort[0][direction]=desc&length=2
 *   -> { response: { data: [{ period: "YYYY-MM-DDTHH", "value": "1234.5", type, ... }] } }
 *
 * Field mapping (1.5.4): MW. type=NG (net generation) -> energyGenerated,
 * type=D (demand) -> energyConsumed. `respondent` is a balancing-authority code
 * (default 'US48' = contiguous US).
 */

const HOSTS = ['api.eia.gov'];
const BASE = 'https://api.eia.gov/v2/electricity/rto/region-data/data/';

const DEFAULT_RESPONDENT = 'US48';
// EIA reports in MWh for hourly buckets; treat the hourly value as an MW rate.
const TYPE_GENERATION = 'NG';
const TYPE_DEMAND = 'D';

const validateConfig = (config) => {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  const respondent =
    typeof cfg.respondent === 'string' && /^[A-Z0-9]{2,8}$/.test(cfg.respondent)
      ? cfg.respondent
      : DEFAULT_RESPONDENT;

  return { ok: true, normalized: { respondent }, errors };
};

const buildQuery = (respondent, type) =>
  new URLSearchParams({
    frequency: 'hourly',
    'data[0]': 'value',
    'facets[respondent][]': respondent,
    'facets[type][]': type,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '1',
  }).toString();

const fetchLatestValue = async ({ respondent, type, fetch, apiKey }) => {
  if (!apiKey) throw new Error('EIA requires an API key (EIA_API_KEY)');
  const url = `${BASE}?${buildQuery(respondent, type)}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) {
    const detail = res.status === 401 || res.status === 403 ? ' (invalid/missing API key)' : '';
    throw new Error(`EIA HTTP ${res.status} for type ${type}${detail}`);
  }
  const json = await res.json();
  const rows = json?.response?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[0];
  const mw = coerceMw(row?.value);
  if (mw === null) return null;

  // `period` is "YYYY-MM-DDTHH" (local-ish). Append ":00:00Z" so Date parses.
  let ts = null;
  if (row?.period) {
    const date = new Date(`${row.period}:00Z`);
    if (!Number.isNaN(date.getTime())) ts = date;
  }
  return { value: mw, timestamp: ts || new Date() };
};

const fetchLatest = async ({ config, apiKey, fetch }) => {
  const { respondent } = validateConfig(config).normalized;

  const [gen, dem] = await Promise.all([
    fetchLatestValue({ respondent, type: TYPE_GENERATION, fetch, apiKey }).catch(() => null),
    fetchLatestValue({ respondent, type: TYPE_DEMAND, fetch, apiKey }).catch(() => null),
  ]);

  if (!gen && !dem) throw new Error('EIA returned no usable data');

  const timestamp = (gen?.timestamp && dem?.timestamp && gen.timestamp > dem.timestamp
    ? gen.timestamp
    : dem?.timestamp || gen?.timestamp);

  const normalized = normalizeReading({
    energyGenerated: gen?.value ?? null,
    energyConsumed: dem?.value ?? null,
    timestamp,
    externalReadingId: buildExternalReadingId('eia', respondent, gen?.timestamp?.toISOString() || dem?.timestamp?.toISOString()),
    unit: 'MW',
  });
  if (!normalized.ok) throw new Error(`EIA normalize failed: ${normalized.message}`);

  return { readings: [normalized.reading], sourceTimestamp: timestamp };
};

module.exports = {
  providerKey: 'eia_us',
  displayName: 'USA — EIA Electric Grid',
  attribution: 'Data: U.S. Energy Information Administration (EIA) open data',
  hosts: HOSTS,
  requiresApiKey: true,
  apiKeyEnvVar: 'EIA_API_KEY',
  validateConfig,
  fetchLatest,
  DEFAULT_RESPONDENT,
};
