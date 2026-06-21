/**
 * EcoPulse authenticated end-to-end workflow test.
 *
 * Prerequisites:
 *   - MongoDB running (MONGO_URI configured in backend/.env)
 *   - Backend server already started (default http://localhost:5000)
 *
 * Run: npm run test:e2e --prefix backend
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const BASE = process.env.API_BASE || 'http://localhost:5000/api/v1';
const API_ORIGIN = BASE.replace(/\/api\/v1\/?$/, '');

let cookieJar = '';

const mergeCookies = (setCookieHeader) => {
  if (!setCookieHeader) return;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const pairs = headers.map((entry) => entry.split(';')[0].trim()).filter(Boolean);
  if (!pairs.length) return;

  const existing = cookieJar
    ? cookieJar.split('; ').filter(Boolean)
    : [];
  const map = new Map(existing.map((pair) => pair.split('=')));

  for (const pair of pairs) {
    const [key, ...rest] = pair.split('=');
    map.set(key, rest.join('='));
  }

  cookieJar = [...map.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
};

const request = async (method, path, body, { auth = true } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && cookieJar) headers.Cookie = cookieJar;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  mergeCookies(res.headers.getSetCookie?.() || res.headers.raw?.()['set-cookie']);

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertForbidden = (result, label) => {
  assert(result.status === 403, `${label} should be forbidden for regular users (got ${result.status})`);
};

const run = async () => {
  console.log('EcoPulse E2E Test (authenticated)\n');

  const healthRes = await fetch(`${API_ORIGIN}/api/health`);
  assert(healthRes.ok, 'Health check failed');

  const email = `mvp-${Date.now()}@test.com`;
  const password = 'TestPass123!';

  const register = await request('POST', '/auth/register', {
    name: 'MVP Tester',
    email,
    password,
  }, { auth: false });
  assert(register.ok, `Registration failed: ${register.status} ${JSON.stringify(register.data)}`);

  const login = await request('POST', '/auth/login', { email, password }, { auth: false });
  assert(login.ok, `Login failed: ${login.status} ${JSON.stringify(login.data)}`);
  assert(cookieJar.includes('accessToken='), 'Login did not set accessToken cookie');

  const me = await request('GET', '/auth/me');
  assert(me.ok, `Auth/me failed: ${me.status}`);

  const summaryBefore = await request('GET', '/analytics/summary');
  assert(summaryBefore.ok, `Analytics summary failed: ${summaryBefore.status}`);

  const nodes = await request('GET', '/nodes');
  assert(nodes.ok, `Nodes fetch failed: ${nodes.status}`);

  const readings = await request('GET', '/readings?limit=5');
  assert(readings.ok, `Readings fetch failed: ${readings.status}`);

  assertForbidden(await request('GET', '/analytics/energy'), 'Platform energy analytics');
  assertForbidden(await request('GET', '/analytics/nodes'), 'Platform node analytics');
  assertForbidden(await request('GET', '/analytics/trades'), 'Platform trade analytics');
  assertForbidden(await request('GET', '/analytics/status'), 'Platform status');
  assertForbidden(await request('POST', '/analytics/sync'), 'Blockchain sync');

  const carbon = await request('GET', '/analytics/carbon');
  assert(
    carbon.status === 400 || carbon.status === 403,
    `Carbon analytics should require wallet scope (got ${carbon.status})`,
  );

  const forecast = await request('GET', '/forecast?days=7');
  const forecastAcceptable = forecast.ok || [500, 502, 503, 504].includes(forecast.status);
  assert(forecastAcceptable, `Forecast endpoint unexpected failure: ${forecast.status}`);

  console.log('✓ Health check');
  console.log('✓ Register + login (cookie auth)');
  console.log('✓ Authenticated summary, nodes, and readings');
  console.log('✓ Platform admin analytics correctly forbidden');
  console.log(forecast.ok ? '✓ AI forecast proxy' : '⚠ AI forecast unavailable (service may be offline)');
  console.log('\nAll E2E workflow checks passed.');
};

run().catch((err) => {
  console.error('\nE2E test failed:', err.message);
  process.exit(1);
});
