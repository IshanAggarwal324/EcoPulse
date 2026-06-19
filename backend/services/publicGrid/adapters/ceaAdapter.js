const { coerceMw, sumMw, normalizeReading, buildExternalReadingId } = require('./baseAdapter');

/**
 * CEA adapter — Central Electricity Authority (India). No API key.
 *
 * Reference endpoint (https://cea.nic.in — monthly power generation reports).
 * CEA primarily publishes monthly/aggregate data, so this adapter is most
 * useful for historical backfill rather than realtime.
 *
 * The CEA endpoint shape is not a stable JSON contract, so this adapter is
 * intentionally tolerant: it accepts either a bare JSON array or
 * `{ data: [...] }` and reads the latest entry by a configurable timestamp
 * field. Generation fields are summed. Field names + endpoint path are
 * configurable via source `config` so an operator can track the published
 * format without code changes.
 *
 * Field mapping (1.5.4): MW (national aggregate). Sum of configured generation
 * fields -> energyGenerated; configured consumption field -> energyConsumed.
 */

const HOSTS = ['cea.nic.in'];
const DEFAULT_PATH = '/api/power_generation.php';
const DEFAULT_GENERATION_FIELDS = ['thermal', 'hydro', 'nuclear', 'renewable'];
const DEFAULT_CONSUMPTION_FIELD = 'consumption';
const DEFAULT_TIMESTAMP_FIELD = 'date';

const validateConfig = (config) => {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  // Strict path only: must start with a single '/', may not contain '//' (which
  // would be protocol-relative and could smuggle a host) or ':' (which could
  // form a scheme). Defense in depth — safeFetch still re-validates the host.
  const rawPath = typeof cfg.path === 'string' ? cfg.path.trim() : '';
  const path =
    /^\/[A-Za-z0-9_./?=&-]*$/.test(rawPath) && !rawPath.includes('//')
      ? rawPath
      : DEFAULT_PATH;

  const generationFields =
    Array.isArray(cfg.generationFields) && cfg.generationFields.length
      ? cfg.generationFields.map((f) => String(f).trim()).filter(Boolean)
      : DEFAULT_GENERATION_FIELDS;

  const consumptionField =
    typeof cfg.consumptionField === 'string' && cfg.consumptionField.trim()
      ? cfg.consumptionField.trim()
      : DEFAULT_CONSUMPTION_FIELD;

  const timestampField =
    typeof cfg.timestampField === 'string' && cfg.timestampField.trim()
      ? cfg.timestampField.trim()
      : DEFAULT_TIMESTAMP_FIELD;

  return { ok: true, normalized: { path, generationFields, consumptionField, timestampField }, errors };
};

const latestEntry = (rows, timestampField) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const withTs = rows
    .map((row) => ({ row, ts: row?.[timestampField] ? new Date(row[timestampField]) : null }))
    .filter((e) => e.ts && !Number.isNaN(e.ts.getTime()));
  if (withTs.length === 0) {
    // Fall back to the last row if none carries a parseable timestamp.
    return { row: rows[rows.length - 1], ts: null };
  }
  return withTs.reduce((best, e) => (e.ts > best.ts ? e : best));
};

const fetchLatest = async ({ config, fetch }) => {
  const { path, generationFields, consumptionField, timestampField } = validateConfig(
    config,
  ).normalized;

  const res = await fetch(`https://cea.nic.in${path}`);
  if (!res.ok) throw new Error(`CEA HTTP ${res.status}`);
  const json = await res.json();

  const rows = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(rows)) throw new Error('CEA response is not an array');

  const latest = latestEntry(rows, timestampField);
  if (!latest?.row) throw new Error('CEA returned no rows');

  const generated = sumMw(generationFields.map((f) => latest.row[f]));
  const consumed = coerceMw(latest.row[consumptionField]);
  const timestamp = latest.ts || new Date();

  const normalized = normalizeReading({
    energyGenerated: generated,
    energyConsumed: consumed,
    timestamp,
    externalReadingId: buildExternalReadingId('cea', timestamp.toISOString().slice(0, 10)),
    unit: 'MW',
  });
  if (!normalized.ok) throw new Error(`CEA normalize failed: ${normalized.message}`);

  return { readings: [normalized.reading], sourceTimestamp: timestamp };
};

module.exports = {
  providerKey: 'cea_in',
  displayName: 'India — CEA Power Generation',
  attribution: 'Data: Central Electricity Authority (CEA), Government of India',
  hosts: HOSTS,
  requiresApiKey: false,
  apiKeyEnvVar: null,
  validateConfig,
  fetchLatest,
  DEFAULT_GENERATION_FIELDS,
};
