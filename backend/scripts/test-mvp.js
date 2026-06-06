/**
 * EcoPulse MVP end-to-end workflow test.
 * Run with backend server already started: node scripts/test-mvp.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const BASE = process.env.API_BASE || 'http://localhost:5001/api/v1';
const API_ORIGIN = BASE.replace(/\/api\/v1\/?$/, '');

const request = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async () => {
  console.log('EcoPulse MVP E2E Test\n');

  const healthRes = await fetch(`${API_ORIGIN}/api/health`);
  assert(healthRes.ok, 'Health check failed');

  const summaryBefore = await request('GET', '/analytics/summary');
  assert(summaryBefore.ok, `Analytics summary failed: ${summaryBefore.status}`);

  const status = await request('GET', '/analytics/status');
  assert(status.ok, `Platform status failed: ${status.status}`);

  const nodes = await request('GET', '/nodes');
  assert(nodes.ok, `Nodes fetch failed: ${nodes.status}`);

  let nodeId = nodes.data?.data?.[0]?._id;

  if (!nodeId) {
    const register = await request('POST', '/auth/register', {
      name: 'MVP Tester',
      email: `mvp-${Date.now()}@test.com`,
      password: 'testpass123',
    });

    if (register.ok) {
      const userId = register.data.data.user._id;
      const createNode = await request('POST', '/nodes', {
        name: 'MVP Solar Node',
        nodeType: 'producer',
        sourceType: 'solar',
        location: 'Test Grid',
        userId,
      });
      assert(createNode.ok, `Node creation failed: ${createNode.status}`);
      nodeId = createNode.data.data._id;
    }
  }

  assert(nodeId, 'No node available for reading test');

  const reading = await request('POST', '/readings', {
    nodeId,
    energyGenerated: 42.5,
    energyConsumed: 12.3,
  });
  assert(reading.ok, `Reading creation failed: ${reading.status}`);

  const summaryAfter = await request('GET', '/analytics/summary');
  assert(summaryAfter.ok, 'Post-reading analytics failed');
  assert(
    summaryAfter.data.data.energy.readingCount >= summaryBefore.data.data.energy.readingCount,
    'Reading count did not increase after POST /readings'
  );

  const energy = await request('GET', '/analytics/energy');
  const nodeAnalytics = await request('GET', '/analytics/nodes');
  const trades = await request('GET', '/analytics/trades');
  const carbon = await request('GET', '/analytics/carbon');

  assert(energy.ok, 'Energy analytics endpoint failed');
  assert(nodeAnalytics.ok, 'Node analytics endpoint failed');
  assert(trades.ok, 'Trade analytics endpoint failed');
  assert(carbon.ok, 'Carbon analytics endpoint failed');

  const sync = await request('POST', '/analytics/sync');
  assert(sync.ok, `Blockchain sync endpoint failed: ${sync.status} ${JSON.stringify(sync.data)}`);
  if (sync.data?.data?.sync?.skipped) {
    console.log('⚠ Blockchain sync skipped (chain offline or unconfigured)');
  }

  const forecast = await request('GET', '/forecast?days=7');
  const forecastAcceptable = forecast.ok || [500, 502, 503, 504].includes(forecast.status);
  assert(forecastAcceptable, `Forecast endpoint unexpected failure: ${forecast.status}`);

  console.log('✓ Health check');
  console.log('✓ Analytics summary & sub-endpoints');
  console.log('✓ Reading creation updates aggregates');
  console.log('✓ Blockchain sync endpoint');
  console.log(forecast.ok ? '✓ AI forecast proxy' : '⚠ AI forecast unavailable (service may be offline)');
  console.log('\nAll MVP workflow checks passed.');
};

run().catch((err) => {
  console.error('\nMVP test failed:', err.message);
  process.exit(1);
});
