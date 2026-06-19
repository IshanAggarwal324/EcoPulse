/**
 * Public-grid adapter registry (Sub-module 1.5.2).
 *
 * Maps a `providerKey` to its adapter module. The registry is the single place
 * the service/worker looks up "which adapter handles this source" — and the
 * single place that enumerates which providers exist (so `providerKey` values
 * in the DB are always backed by real code).
 */

const smard = require('./smardAdapter');
const cea = require('./ceaAdapter');
const eia = require('./eiaAdapter');
const fingrid = require('./fingridAdapter');
const entsoe = require('./entsoeAdapter');

const ADAPTERS = {
  smard_de: smard,
  cea_in: cea,
  eia_us: eia,
  fingrid_fi: fingrid,
  entsoe_eu: entsoe,
};

const PROVIDER_KEYS = Object.keys(ADAPTERS);

/**
 * Resolve the adapter for a providerKey. Returns the module or null when the
 * key is unknown (never throws — callers surface a clear validation error).
 */
const getAdapter = (providerKey) => ADAPTERS[providerKey] || null;

/**
 * Resolve + validate config for a provider. Used at create/update time so a
 * source never persists with config the adapter will reject at poll time.
 */
const validateProviderConfig = (providerKey, config) => {
  const adapter = getAdapter(providerKey);
  if (!adapter) {
    return { ok: false, code: 'UNKNOWN_PROVIDER', message: `Unknown providerKey: ${providerKey}` };
  }
  const result = adapter.validateConfig(config || {});
  return {
    ok: true,
    adapter,
    normalized: result.normalized,
    warnings: result.errors || [],
  };
};

/**
 * Seed defaults for the admin UI / seed script: one entry per provider with
 * suggested displayName, attribution, apiKeyEnvVar, and default config.
 */
const providerCatalog = () =>
  PROVIDER_KEYS.map((key) => {
    const a = ADAPTERS[key];
    return {
      providerKey: key,
      displayName: a.displayName,
      attribution: a.attribution,
      requiresApiKey: a.requiresApiKey,
      apiKeyEnvVar: a.apiKeyEnvVar,
      hosts: a.hosts,
      defaultConfig: a.validateConfig({}).normalized,
    };
  });

module.exports = {
  ADAPTERS,
  PROVIDER_KEYS,
  getAdapter,
  validateProviderConfig,
  providerCatalog,
};
