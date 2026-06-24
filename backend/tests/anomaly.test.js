const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const ApiError = require('../utils/apiError');

process.env.INTERNAL_SERVICE_API_KEY = 'sekret';

// ---------------------------------------------------------------------------
// Isolated mocking: the controller destructures its deps at require-time, so we
// expose STABLE mock functions that read mutable `state` at call-time. That lets
// each test flip behaviour without re-requiring the controller. Global
// require.cache is snapshotted+restored so other test files are unaffected.
// ---------------------------------------------------------------------------

const state = {
  privileged: false,
  denyNode: false,
  ownedIds: [],
  fetchThrows: null,
  fetchOk: true,
  fetchStatus: 200,
  fetchJson: {
    node_id: '507f1f77bcf86cd799439011',
    window_days: 7,
    model_status: 'ready',
    model_version: 'v1',
    total_readings: 10,
    flagged_count: 1,
    flagged: [
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        generation: 1,
        consumption: 9,
        anomaly_score: 0.9,
        is_anomaly: true,
        reason_codes: ['consumption_spike'],
      },
    ],
  },
};

const calls = { ownership: [], fetch: [], bulkWrite: [], getOwned: [] };

const ownershipMock = {
  isPrivileged: () => state.privileged,
  assertNodeOwnership: async (u, id) => {
    calls.ownership.push({ fn: 'single', u, id });
  },
  assertNodesOwnership: async (u, ids) => {
    calls.ownership.push({ fn: 'multi', u, ids });
    if (state.denyNode) throw new ApiError('forbidden', 403, 'NODE_NOT_OWNED');
  },
  getOwnedNodeIds: async (u) => {
    calls.getOwned.push(u);
    return state.ownedIds;
  },
};

const fetchMock = {
  fetchWithTimeout: async (url, opts) => {
    calls.fetch.push({ url, opts });
    if (state.fetchThrows) throw state.fetchThrows;
    return {
      ok: state.fetchOk,
      status: state.fetchStatus,
      json: async () => state.fetchJson,
      text: async () => JSON.stringify(state.fetchJson),
    };
  },
};

const anomalyEventMock = {
  bulkWrite: async (ops) => {
    calls.bulkWrite.push(ops);
    return { upsertedCount: ops.length };
  },
};

const energyNodeMock = {
  find: () => ({
    limit: () => ({
      lean: async () => [
        { _id: '507f1f77bcf86cd799439011' },
        { _id: '111111111111111111111111' },
      ],
    }),
  }),
};

const serviceUrlsMock = { getAiServiceUrl: () => 'http://ai.test' };

const mockExports = {
  '../config/serviceUrls': serviceUrlsMock,
  '../utils/fetchWithTimeout': fetchMock,
  '../models/AnomalyEvent': anomalyEventMock,
  '../models/EnergyNode': energyNodeMock,
  '../utils/nodeOwnership': ownershipMock,
};

const mockPaths = Object.keys(mockExports);
const originals = {};
let getAnomalies;

before(() => {
  for (const p of mockPaths) {
    const abs = require.resolve(p);
    if (require.cache[abs]) originals[abs] = require.cache[abs];
    require.cache[abs] = {
      id: abs,
      filename: abs,
      loaded: true,
      exports: mockExports[p],
      paths: [],
      children: [],
    };
  }
  const ctrlPath = require.resolve('../controllers/anomalyController');
  delete require.cache[ctrlPath];
  ({ getAnomalies } = require('../controllers/anomalyController'));
});

after(() => {
  for (const abs of Object.keys(originals)) {
    require.cache[abs] = originals[abs];
  }
  for (const p of mockPaths) {
    const abs = require.resolve(p);
    if (!originals[abs]) delete require.cache[abs];
  }
  delete require.cache[require.resolve('../controllers/anomalyController')];
});

const VALID_ID = '507f1f77bcf86cd799439011';

function resetState() {
  state.privileged = false;
  state.denyNode = false;
  state.ownedIds = [];
  state.fetchThrows = null;
  state.fetchOk = true;
  state.fetchStatus = 200;
  state.fetchJson = {
    node_id: VALID_ID,
    window_days: 7,
    model_status: 'ready',
    model_version: 'v1',
    total_readings: 10,
    flagged_count: 1,
    flagged: [
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        generation: 1,
        consumption: 9,
        anomaly_score: 0.9,
        is_anomaly: true,
        reason_codes: ['consumption_spike'],
      },
    ],
  };
  calls.ownership = [];
  calls.fetch = [];
  calls.bulkWrite = [];
  calls.getOwned = [];
}

async function callHandler(query) {
  // asyncHandler returns synchronously (it does not await its inner promise),
  // so we resolve a deferred from res.json / next to know when work finished.
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      resolveDone();
      return this;
    },
  };
  let nextArg;
  const next = (err) => {
    nextArg = err;
    resolveDone();
  };
  getAnomalies({ user: { _id: 'u1', role: 'user' }, query }, res, next);
  // Safety timeout so a misbehaving handler fails instead of hanging the runner.
  await Promise.race([
    done,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  return { res, nextArg };
}

beforeEach(() => resetState());

test('rejects malformed nodeId with 400 INVALID_NODE_ID', async () => {
  const { nextArg } = await callHandler({ nodeId: 'not-an-id' });
  assert.ok(nextArg instanceof ApiError);
  assert.strictEqual(nextArg.statusCode, 400);
  assert.strictEqual(nextArg.code, 'INVALID_NODE_ID');
});

test('rejects out-of-range days with 400', async () => {
  const { nextArg } = await callHandler({ days: '0' });
  assert.ok(nextArg instanceof ApiError);
  assert.strictEqual(nextArg.statusCode, 400);
  assert.strictEqual(nextArg.code, 'INVALID_ANOMALY_DAYS');
});

test('rejects future since date with 400 INVALID_SINCE', async () => {
  const future = new Date(Date.now() + 10 ** 8).toISOString();
  const { nextArg } = await callHandler({ days: '7', since: future });
  assert.ok(nextArg instanceof ApiError);
  assert.strictEqual(nextArg.statusCode, 400);
  assert.strictEqual(nextArg.code, 'INVALID_SINCE');
});

test('rejects too many nodeIds with 400', async () => {
  const ids = Array.from({ length: 51 }, () => VALID_ID).join(',');
  const { nextArg } = await callHandler({ nodeIds: ids });
  assert.ok(nextArg instanceof ApiError);
  assert.strictEqual(nextArg.code, 'TOO_MANY_NODE_IDS');
});

test('IDOR: denies a node the non-privileged user does not own (403) and never calls AI', async () => {
  state.denyNode = true;
  const { nextArg } = await callHandler({ nodeId: VALID_ID });
  assert.ok(nextArg instanceof ApiError);
  assert.strictEqual(nextArg.statusCode, 403);
  assert.strictEqual(calls.fetch.length, 0, 'AI must not be contacted when ownership fails');
  assert.strictEqual(calls.ownership.length, 1);
});

test('scores an owned single node, persists flagged events, returns 200', async () => {
  const { res, nextArg } = await callHandler({ nodeId: VALID_ID });
  assert.strictEqual(nextArg, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.flagged_count, 1);
  assert.strictEqual(res.body.node_id, VALID_ID);
  assert.strictEqual(calls.bulkWrite.length, 1, 'flagged events must be persisted');
  // Internal API key must be forwarded on the upstream call.
  assert.strictEqual(
    calls.fetch[0].opts.headers['x-internal-api-key'],
    'sekret',
  );
  const body = JSON.parse(calls.fetch[0].opts.body);
  assert.strictEqual(body.node_id, VALID_ID);
  assert.strictEqual(body.window_days, 7);
});

test('persist=false skips event persistence', async () => {
  const { res } = await callHandler({ nodeId: VALID_ID, persist: 'false' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.bulkWrite.length, 0);
});

test('returns 503 when the AI service is unreachable', async () => {
  state.fetchThrows = new Error('timeout');
  const { res } = await callHandler({ nodeId: VALID_ID });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.success, false);
});

test('forwards upstream non-2xx with 503-style error body', async () => {
  state.fetchOk = false;
  state.fetchStatus = 500;
  const { res } = await callHandler({ nodeId: VALID_ID });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.success, false);
});

test('no owned nodes returns empty no_nodes result', async () => {
  state.ownedIds = [];
  const { res, nextArg } = await callHandler({});
  assert.strictEqual(nextArg, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.model_status, 'no_nodes');
  assert.strictEqual(res.body.flagged_count, 0);
});

test('admin allNodes resolves a bounded node set and batches upstream', async () => {
  state.privileged = true;
  state.fetchJson = {
    results: [
      {
        node_id: '507f1f77bcf86cd799439011',
        window_days: 7,
        model_status: 'ready',
        total_readings: 5,
        flagged_count: 0,
        flagged: [],
      },
      {
        node_id: '111111111111111111111111',
        window_days: 7,
        model_status: 'ready',
        total_readings: 5,
        flagged_count: 0,
        flagged: [],
      },
    ],
    model_status: 'ready',
  };
  const { res, nextArg } = await callHandler({ allNodes: 'true' });
  assert.strictEqual(nextArg, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.results));
  assert.strictEqual(res.body.results.length, 2);
  assert.ok(calls.fetch[0].url.endsWith('/anomaly/batch'));
});

test('non-privileged allNodes is ignored — scores own nodes, never global', async () => {
  state.privileged = false;
  state.ownedIds = ['222222222222222222222222'];
  state.fetchJson = {
    node_id: '222222222222222222222222',
    window_days: 7,
    model_status: 'ready',
    total_readings: 3,
    flagged_count: 0,
    flagged: [],
  };
  const { res, nextArg } = await callHandler({ allNodes: 'true' });
  assert.strictEqual(nextArg, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.node_id, '222222222222222222222222');
});
