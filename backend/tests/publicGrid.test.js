const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 1.5 — pure-logic invariants (no Mongo/Redis required).
const baseAdapter = require('../services/publicGrid/adapters/baseAdapter');
const { assertSafeUrl } = require('../services/publicGrid/httpClient');
const gridConfig = require('../config/publicGrid');
const registry = require('../services/publicGrid/adapters/registry');
const PublicGridSource = require('../models/PublicGridSource');
const entsoe = require('../services/publicGrid/adapters/entsoeAdapter');
const smard = require('../services/publicGrid/adapters/smardAdapter');
const eia = require('../services/publicGrid/adapters/eiaAdapter');
const cea = require('../services/publicGrid/adapters/ceaAdapter');
const fingrid = require('../services/publicGrid/adapters/fingridAdapter');
const publicGridService = require('../services/publicGrid/publicGridService');

/* ------------------------------------------------------------------ */
/* baseAdapter value hygiene (guardrail 1.5.7)                         */
/* ------------------------------------------------------------------ */

test('coerceMw treats null/"-"/garbage as no-data, not zero', () => {
  assert.strictEqual(baseAdapter.coerceMw(null), null);
  assert.strictEqual(baseAdapter.coerceMw(undefined), null);
  assert.strictEqual(baseAdapter.coerceMw(''), null);
  assert.strictEqual(baseAdapter.coerceMw('-'), null);
  assert.strictEqual(baseAdapter.coerceMw('abc'), null);
  assert.strictEqual(baseAdapter.coerceMw(-5), null); // negative -> no-data
  assert.strictEqual(baseAdapter.coerceMw(0), 0);
  assert.strictEqual(baseAdapter.coerceMw('123.4'), 123.4);
});

test('sumMw returns null when every value is missing', () => {
  assert.strictEqual(baseAdapter.sumMw([null, null, '-']), null);
  assert.strictEqual(baseAdapter.sumMw([]), null);
  assert.strictEqual(baseAdapter.sumMw([1, null, 2]), 3);
  assert.strictEqual(baseAdapter.sumMw(['1.5', '2.5']), 4);
});

test('normalizeReading rejects NaN/negative/outliers and requires an external id', () => {
  const ok = baseAdapter.normalizeReading({
    energyGenerated: 100, energyConsumed: 50,
    timestamp: '2024-01-01T00:00:00Z', externalReadingId: 'smard:1',
  });
  assert.ok(ok.ok);
  assert.strictEqual(ok.reading.energyGenerated, 100);
  assert.strictEqual(ok.reading.unit, 'MW');

  assert.ok(!baseAdapter.normalizeReading({ energyGenerated: null, energyConsumed: null, externalReadingId: 'x' }).ok);
  assert.ok(!baseAdapter.normalizeReading({ energyGenerated: 10, externalReadingId: 'x', maxCapacityMw: 5 }).ok); // OUT_OF_RANGE
  assert.ok(!baseAdapter.normalizeReading({ energyGenerated: 10, timestamp: 'not-a-date', externalReadingId: 'x' }).ok);
  assert.ok(!baseAdapter.normalizeReading({ energyGenerated: 10, timestamp: new Date(Date.now() + 48 * 3600 * 1000), externalReadingId: 'x' }).ok); // FUTURE_DATED
  assert.ok(!baseAdapter.normalizeReading({ energyGenerated: 10 }).ok); // MISSING_EXTERNAL_ID
});

test('buildExternalReadingId is secret-free and capped', () => {
  const id = baseAdapter.buildExternalReadingId('smard', '410', 'DE', 1700000000000);
  assert.strictEqual(id, 'smard:410:DE:1700000000000');
  assert.ok(!id.includes('key='));
  const long = baseAdapter.buildExternalReadingId('x'.repeat(300));
  assert.ok(long.length <= 200);
});

/* ------------------------------------------------------------------ */
/* SSRF guard (httpClient.assertSafeUrl + config.isPrivateHost)        */
/* ------------------------------------------------------------------ */

test('isPrivateHost blocks loopback/private/link-local/metadata addresses', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', 'localhost', 'metadata.google.internal', '::1', 'fc00::1', 'fe80::1']) {
    assert.ok(gridConfig.isPrivateHost(h), `${h} should be private`);
  }
  for (const h of ['8.8.8.8', 'www.smard.de', 'api.eia.gov', 'data.fingrid.fi']) {
    assert.ok(!gridConfig.isPrivateHost(h), `${h} should be public`);
  }
});

test('assertSafeUrl enforces HTTPS, allowlist, no embedded creds, no private hosts', () => {
  const allow = ['api.eia.gov'];
  // Happy path.
  assert.doesNotThrow(() => assertSafeUrl('https://api.eia.gov/v2/data', allow));
  assert.doesNotThrow(() => assertSafeUrl('https://sub.api.eia.gov/v2/data', allow)); // subdomain ok

  // http rejected.
  assert.throws(() => assertSafeUrl('http://api.eia.gov/v2', allow), /HTTPS/);
  // Non-allowlisted host rejected (SSRF — admin cannot redirect).
  assert.throws(() => assertSafeUrl('https://evil.com/v2', allow), /allowlist/);
  assert.throws(() => assertSafeUrl('https://169.254.169.254/latest/meta-data/', allow), /allowlist|private/i);
  // Embedded credentials rejected.
  assert.throws(() => assertSafeUrl('https://user:pass@api.eia.gov/v2', allow), /credentials/);
  // Sibling domain that merely ends in the same suffix letters is NOT allowed.
  assert.throws(() => assertSafeUrl('https://noteia.gov/', allow), /allowlist/);
});

/* ------------------------------------------------------------------ */
/* Adapter registry + interface contract                               */
/* ------------------------------------------------------------------ */

test('registry provider keys match the model enum and the catalog', () => {
  assert.deepStrictEqual(
    [...registry.PROVIDER_KEYS].sort(),
    [...PublicGridSource.PROVIDER_KEYS].sort(),
  );
});

test('every adapter exposes the required interface and a non-empty host allowlist', () => {
  for (const key of registry.PROVIDER_KEYS) {
    const a = registry.getAdapter(key);
    assert.ok(a, `adapter missing for ${key}`);
    assert.strictEqual(a.providerKey, key);
    assert.ok(typeof a.displayName === 'string' && a.displayName);
    assert.ok(Array.isArray(a.hosts) && a.hosts.length > 0, `${key} needs hosts`);
    assert.ok(typeof a.attribution === 'string');
    assert.ok(typeof a.requiresApiKey === 'boolean');
    assert.strictEqual(typeof a.validateConfig, 'function');
    assert.strictEqual(typeof a.fetchLatest, 'function');
    // keyed providers must declare an env-var name; keyless must not.
    if (a.requiresApiKey) {
      assert.ok(a.apiKeyEnvVar, `${key} requires apiKeyEnvVar`);
    } else {
      assert.ok(a.apiKeyEnvVar === null || a.apiKeyEnvVar === undefined, `${key} should be keyless`);
    }
  }
});

test('validateProviderConfig rejects unknown provider and normalizes defaults', () => {
  assert.ok(!registry.validateProviderConfig('nope', {}).ok);

  const sm = registry.validateProviderConfig('smard_de', {});
  assert.ok(sm.ok && sm.normalized.region === 'DE');
  assert.ok(Array.isArray(sm.normalized.generationFilters));

  const eiaRes = registry.validateProviderConfig('eia_us', {});
  assert.ok(eiaRes.ok && eiaRes.normalized.respondent === 'US48');
});

/* ------------------------------------------------------------------ */
/* Per-adapter config validation                                       */
/* ------------------------------------------------------------------ */

test('smard config accepts region + filters and sanitizes garbage', () => {
  const v = smard.validateConfig({ region: 'DE', generationFilters: [410], consumptionFilter: 4100 });
  assert.ok(v.ok);
  assert.deepStrictEqual(v.normalized.generationFilters, [410]);
  assert.strictEqual(v.normalized.consumptionFilter, 4100);

  const bad = smard.validateConfig({ generationFilters: [], region: 'evil!host' });
  assert.ok(bad.ok); // falls back to defaults safely
  assert.strictEqual(bad.normalized.region, 'DE');
});

test('cea config rejects path traversal / host injection', () => {
  assert.strictEqual(cea.validateConfig({}).normalized.path, '/api/power_generation.php');
  const bad = cea.validateConfig({ path: '//evil.com/x' });
  assert.strictEqual(bad.normalized.path, '/api/power_generation.php'); // fell back, no host
});

test('eia respondent must be a short uppercase code', () => {
  assert.strictEqual(eia.validateConfig({ respondent: 'CAL' }).normalized.respondent, 'CAL');
  assert.strictEqual(eia.validateConfig({ respondent: 'US-48!!' }).normalized.respondent, 'US48');
});

test('fingrid generation datasets must be positive integers', () => {
  const v = fingrid.validateConfig({ generationDatasets: [74, 247, 0, 'x'] });
  assert.deepStrictEqual(v.normalized.generationDatasets, [74, 247]);
});

test('entsoe zone must be alphanumeric-ish', () => {
  assert.strictEqual(entsoe.validateConfig({}).normalized.zone, entsoe.DEFAULT_ZONE);
  const v = entsoe.validateConfig({ zone: '10YDE-ENBW-----N' });
  assert.strictEqual(v.normalized.zone, '10YDE-ENBW-----N');
});

/* ------------------------------------------------------------------ */
/* ENTSO-E XML point extraction                                        */
/* ------------------------------------------------------------------ */

test('entsoe.extractLatestPoint reads the last numeric quantity and computes time', () => {
  const xml = `
    <GL_MarketDocument>
      <TimeSeries>
        <period>
          <timeInterval><start>2024-01-01T00:00Z</start><end>2024-01-01T02:00Z</end></timeInterval>
          <resolution>PT60M</resolution>
          <Point><position>1</position><quantity>5000.5</quantity></Point>
          <Point><position>2</position><quantity>5100.0</quantity></Point>
        </period>
      </TimeSeries>
    </GL_MarketDocument>`;
  const point = entsoe.extractLatestPoint(xml);
  assert.ok(point);
  assert.strictEqual(point.value, 5100);
  assert.strictEqual(new Date('2024-01-01T01:00:00Z').getTime(), point.timestamp.getTime());
});

test('entsoe.extractLatestPoint skips null slots and throws on error docs', () => {
  const xml = `
    <TimeSeries><period>
      <timeInterval><start>2024-01-01T00:00Z</start></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>100</quantity></Point>
      <Point><position>2</position></Point>
      <Point><position>3</position><quantity>300</quantity></Point>
    </period></TimeSeries>`;
  const point = entsoe.extractLatestPoint(xml);
  assert.strictEqual(point.value, 300);

  assert.throws(() => entsoe.extractLatestPoint('<Acknowledge_MarketDocument><Reason><text>No data</text></Reason></Acknowledge_MarketDocument>'), /ENTSO-E error/);
  assert.strictEqual(entsoe.extractLatestPoint('<TimeSeries></TimeSeries>'), null);
});

/* ------------------------------------------------------------------ */
/* Circuit breaker state machine (pure helpers)                        */
/* ------------------------------------------------------------------ */

test('maybeHalfOpen promotes an open breaker after the cooldown elapses', () => {
  const cfg = gridConfig.getCbCooldownMs();
  const fresh = { circuitState: 'open', circuitOpenedAt: new Date(Date.now() - cfg - 1000) };
  const result = publicGridService.maybeHalfOpen({ ...fresh });
  assert.strictEqual(result.circuitState, 'half_open');

  const stillHot = publicGridService.maybeHalfOpen({ circuitState: 'open', circuitOpenedAt: new Date() });
  assert.strictEqual(stillHot.circuitState, 'open');

  const closed = publicGridService.maybeHalfOpen({ circuitState: 'closed' });
  assert.strictEqual(closed.circuitState, 'closed');
});

test('shouldSkipForCircuit is bypassed for manual polls and blocks open breakers', () => {
  const open = { circuitState: 'open', circuitOpenedAt: new Date() };
  assert.strictEqual(publicGridService.shouldSkipForCircuit(open, { manual: false }), true);
  assert.strictEqual(publicGridService.shouldSkipForCircuit(open, { manual: true }), false);
  assert.strictEqual(publicGridService.shouldSkipForCircuit({ circuitState: 'closed' }, { manual: false }), false);
});

/* ------------------------------------------------------------------ */
/* Feature flag resolution                                             */
/* ------------------------------------------------------------------ */

test('isPublicGridEnabled defaults to false and reads the flag', () => {
  const original = process.env.PUBLIC_GRID_INGESTION_ENABLED;
  delete process.env.PUBLIC_GRID_INGESTION_ENABLED;
  assert.strictEqual(gridConfig.isPublicGridEnabled(), false);
  process.env.PUBLIC_GRID_INGESTION_ENABLED = 'true';
  assert.strictEqual(gridConfig.isPublicGridEnabled(), true);
  process.env.PUBLIC_GRID_INGESTION_ENABLED = 'false';
  assert.strictEqual(gridConfig.isPublicGridEnabled(), false);
  if (original === undefined) delete process.env.PUBLIC_GRID_INGESTION_ENABLED;
  else process.env.PUBLIC_GRID_INGESTION_ENABLED = original;
});

test('poll interval has a sane floor', () => {
  const original = process.env.PUBLIC_GRID_POLL_INTERVAL_MS;
  process.env.PUBLIC_GRID_POLL_INTERVAL_MS = '1000'; // too low
  assert.ok(gridConfig.getDefaultPollInterval() >= gridConfig.MIN_POLL_INTERVAL_MS);
  if (original === undefined) delete process.env.PUBLIC_GRID_POLL_INTERVAL_MS;
  else process.env.PUBLIC_GRID_POLL_INTERVAL_MS = original;
});

test('apiKeyConfigured is true for keyless providers and reflects env for keyed ones', () => {
  assert.strictEqual(publicGridService.isApiKeyConfigured(smard), true); // keyless
  const original = process.env.EIA_API_KEY;
  delete process.env.EIA_API_KEY;
  assert.strictEqual(publicGridService.isApiKeyConfigured(eia), false);
  process.env.EIA_API_KEY = 'test-key';
  assert.strictEqual(publicGridService.isApiKeyConfigured(eia), true);
  if (original === undefined) delete process.env.EIA_API_KEY;
  else process.env.EIA_API_KEY = original;
});
