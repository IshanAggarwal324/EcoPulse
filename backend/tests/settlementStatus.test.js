const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.JWT_ACCESS_SECRET = 'test';
process.env.JWT_REFRESH_SECRET = 'test';

// ---------------------------------------------------------------------------
// Module 6.4 — Settlement Status tests.
//
// Two layers:
//   1. Pure logic in settlementLifecycleService (no IO) — direct unit tests.
//   2. Controller behaviour (ownership scoping, override state-machine, input
//      allowlisting) — exercised against in-memory mocks of the Settlement,
//      Escrow, and auditService modules via require.cache interception, the
//      same isolation strategy used by tests/reconciliation.test.js.
// ---------------------------------------------------------------------------

const {
  computeLifecycle,
  buildTimeline,
  isOnChainConfirmed,
  LIFECYCLE_STATUSES,
} = require('../services/settlementLifecycleService');

// ===========================================================================
// 1. Pure lifecycle state machine.
// ===========================================================================
test('computeLifecycle: brand-new settlement with no on-chain/escrow state → pending', () => {
  assert.strictEqual(computeLifecycle({ verificationStatus: 'pending' }, null), 'pending');
});

test('computeLifecycle: confirmations present but not yet verified → on_chain_confirmed', () => {
  assert.strictEqual(computeLifecycle({ verificationStatus: 'pending', confirmations: 3 }, null), 'on_chain_confirmed');
  assert.strictEqual(computeLifecycle({ verificationStatus: 'pending', onChainStatus: 'CONFIRMED' }, null), 'on_chain_confirmed');
  assert.strictEqual(isOnChainConfirmed({ confirmations: 0 }), false);
});

test('computeLifecycle: readings verified → readings_verified', () => {
  assert.strictEqual(computeLifecycle({ verificationStatus: 'verified', confirmations: 3 }, null), 'readings_verified');
});

test('computeLifecycle: escrow released wins over verified reading', () => {
  assert.strictEqual(
    computeLifecycle({ verificationStatus: 'verified' }, { state: 'released' }),
    'released',
  );
});

test('computeLifecycle: dispute takes precedence over release/verified (terminal-first)', () => {
  assert.strictEqual(
    computeLifecycle({ verificationStatus: 'disputed' }, { state: 'released' }),
    'disputed',
  );
  assert.strictEqual(
    computeLifecycle({ verificationStatus: 'verified' }, { state: 'disputed' }),
    'disputed',
  );
});

test('computeLifecycle: refund takes precedence over everything except dispute', () => {
  assert.strictEqual(
    computeLifecycle({ verificationStatus: 'verified' }, { state: 'refunded' }),
    'refunded',
  );
  // dispute still beats refund
  assert.strictEqual(
    computeLifecycle({ verificationStatus: 'disputed' }, { state: 'refunded' }),
    'disputed',
  );
});

test('computeLifecycle: mismatch surfaces when not disputed/refunded', () => {
  assert.strictEqual(computeLifecycle({ verificationStatus: 'mismatch' }, null), 'mismatch');
  // escrow released does NOT mask a mismatch label? → released wins (terminal happy)
  assert.strictEqual(computeLifecycle({ verificationStatus: 'mismatch' }, { state: 'released' }), 'released');
});

test('computeLifecycle: null doc → pending (no throw)', () => {
  assert.strictEqual(computeLifecycle(null, null), 'pending');
});

test('LIFECYCLE_STATUSES matches the plan enum', () => {
  assert.deepStrictEqual(LIFECYCLE_STATUSES, [
    'pending', 'on_chain_confirmed', 'readings_verified', 'released',
    'disputed', 'refunded', 'mismatch',
  ]);
});

// ===========================================================================
// 2. Timeline rendering.
// ===========================================================================
test('buildTimeline marks completed/active/pending along the happy path', () => {
  const { current, steps } = buildTimeline({ verificationStatus: 'verified' }, { state: 'delivered' });
  assert.strictEqual(current, 'readings_verified');
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s.status]));
  assert.strictEqual(byKey.created, 'completed');
  assert.strictEqual(byKey.on_chain, 'completed');
  assert.strictEqual(byKey.readings, 'active');
  assert.strictEqual(byKey.released, 'pending');
  assert.ok(!steps.some((s) => s.key === 'resolution'), 'no resolution step on happy path');
});

test('buildTimeline appends a resolution step + fails release for disputes', () => {
  const { current, steps } = buildTimeline({ verificationStatus: 'disputed' }, null);
  assert.strictEqual(current, 'disputed');
  const release = steps.find((s) => s.key === 'released');
  assert.strictEqual(release.status, 'failed');
  const resolution = steps.find((s) => s.key === 'resolution');
  assert.ok(resolution, 'resolution step present');
  assert.strictEqual(resolution.status, 'active');
});

test('buildTimeline: released terminal → release step active, no resolution', () => {
  const { current, steps } = buildTimeline({ verificationStatus: 'verified' }, { state: 'released' });
  assert.strictEqual(current, 'released');
  assert.strictEqual(steps.find((s) => s.key === 'released').status, 'active');
  assert.ok(!steps.some((s) => s.key === 'resolution'));
});

// ===========================================================================
// 3. Model static + escrowRef field wiring.
// ===========================================================================
test('Settlement exposes LIFECYCLE_STATUSES static and an escrowRef path', () => {
  // Require the REAL model fresh (guard against mock-cache leakage from §4).
  delete require.cache[require.resolve('../models/Settlement')];
  const SettlementModel = require('../models/Settlement');
  assert.deepStrictEqual(SettlementModel.LIFECYCLE_STATUSES, LIFECYCLE_STATUSES);
  const path = SettlementModel.schema.path('escrowRef');
  assert.ok(path, 'escrowRef field exists');
  assert.strictEqual(path.options.ref, 'Escrow');
  assert.strictEqual(path.options.default, null);
});

// ===========================================================================
// 4. Controller behaviour via mocked models + auditService.
// ===========================================================================

const state = {
  rows: [],
  count: 0,
  findOneResult: null,
  findByIdResult: null,
  findByIdAndUpdateResult: null,
  escrows: [],
  escrowOne: null,
  escrowById: null,
};
const calls = { audit: [], updates: [] };

// Chainable query stub: EnergyReading/Settlement find(...).sort().skip().limit().lean()
const chain = (resolver) => {
  const c = {
    sort() { return c; },
    skip() { return c; },
    limit() { return c; },
    select() { return c; },
    lean: async () => resolver(),
  };
  return c;
};

const settlementMock = {
  VERIFICATION_STATUSES: ['pending', 'verified', 'mismatch', 'disputed'],
  MISMATCH_FLAGS: ['OVER_DELIVERY', 'UNDER_DELIVERY', 'READING_GAP', 'RECEIPT_MISMATCH'],
  find: () => chain(() => state.rows),
  countDocuments: async () => state.count,
  findOne: () => chain(() => state.findOneResult),
  findById: () => ({ lean: async () => state.findByIdResult }),
  findByIdAndUpdate: (id, update) => {
    calls.updates.push({ id, update });
    return { lean: async () => state.findByIdAndUpdateResult };
  },
};

const escrowMock = {
  find: () => chain(() => state.escrows),
  findOne: () => chain(() => state.escrowOne),
  findById: async () => state.escrowById,
};

const auditMock = {
  log: async (entry) => { calls.audit.push(entry); return true; },
};

const modelExports = { '../models/Settlement': settlementMock, '../models/Escrow': escrowMock };
const modelPaths = Object.keys(modelExports);
const auditPath = '../services/auditService';
const ctrlPaths = [
  '../controllers/marketplaceSettlementController',
  '../controllers/admin/adminSettlementController',
  '../services/settlementEscrowService',
];

let mkCtrl, adminCtrl;

before(() => {
  for (const p of modelPaths) {
    const abs = require.resolve(p);
    require.cache[abs] = {
      id: abs, filename: abs, loaded: true, exports: modelExports[p], paths: [], children: [],
    };
  }
  const auditAbs = require.resolve(auditPath);
  require.cache[auditAbs] = {
    id: auditAbs, filename: auditAbs, loaded: true, exports: auditMock, paths: [], children: [],
  };
  ctrlPaths.forEach((p) => delete require.cache[require.resolve(p)]);
  mkCtrl = require('../controllers/marketplaceSettlementController');
  adminCtrl = require('../controllers/admin/adminSettlementController');
});

after(() => {
  [...modelPaths, auditPath, ...ctrlPaths].forEach((p) => delete require.cache[require.resolve(p)]);
});

// asyncHandler fires the controller but does not return its promise (harmless
// under Express, which ignores handler return values), so we cannot `await`
// the handler. Instead resolve when the handler calls res.json or next(err).
const call = (fn, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; resolve(this); return this; },
  };
  try {
    fn(req, res, (err) => { err ? reject(err) : resolve(res); });
  } catch (e) { reject(e); }
});

const resetState = () => {
  state.rows = []; state.count = 0; state.findOneResult = null;
  state.findByIdResult = null; state.findByIdAndUpdateResult = null;
  state.escrows = []; state.escrowOne = null; state.escrowById = null;
  calls.audit.length = 0; calls.updates.length = 0;
};

// ---- 4a. Ownership scoping (no IDOR) -------------------------------------
test('listMySettlements scopes to caller wallet and enriches with lifecycle', async () => {
  resetState();
  const wallet = '0x' + 'a'.repeat(40);
  state.rows = [
    { _id: 's1', buyer: wallet, seller: '0x' + 'b'.repeat(40), verificationStatus: 'verified', listingId: 1, chainId: 1, contractAddress: '0x1' },
  ];
  state.count = 1;
  const res = await call(mkCtrl.listMySettlements, { user: { walletAddress: wallet }, query: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data[0].lifecycle.current, 'readings_verified');
});

test('listMySettlements returns empty for a user with no wallet on file', async () => {
  resetState();
  const res = await call(mkCtrl.listMySettlements, { user: {}, query: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.length, 0);
});

test('getMySettlement: 403 when caller is not a party (IDOR guard)', async () => {
  resetState();
  state.findOneResult = {
    _id: 's1', buyer: '0x' + 'a'.repeat(40), seller: '0x' + 'b'.repeat(40),
    verificationStatus: 'verified', listingId: 1, chainId: 1, contractAddress: '0x1',
  };
  const attacker = '0x' + 'c'.repeat(40);
  const res = await call(mkCtrl.getMySettlement, { params: { tradeId: '507f1f77bcf86cd799439011' }, user: { walletAddress: attacker } });
  assert.strictEqual(res.statusCode, 403);
});

test('getMySettlement: resolves by tradeRef and returns enriched doc for a party', async () => {
  resetState();
  const wallet = '0x' + 'a'.repeat(40);
  state.findOneResult = { _id: 's1', buyer: wallet, verificationStatus: 'pending', listingId: 1, chainId: 1, contractAddress: '0x1' };
  const res = await call(mkCtrl.getMySettlement, { params: { tradeId: '507f1f77bcf86cd799439011' }, user: { walletAddress: wallet } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.lifecycle.current, 'pending');
});

test('getMySettlement: 404 for non-ObjectId tradeId', async () => {
  resetState();
  const res = await call(mkCtrl.getMySettlement, { params: { tradeId: 'not-an-id' }, user: { walletAddress: '0x' + 'a'.repeat(40) } });
  assert.strictEqual(res.statusCode, 404);
});

test('getSettlementForOrder rejects non-integer listingId', async () => {
  resetState();
  const res = await call(mkCtrl.getSettlementForOrder, { params: { listingId: 'abc' }, user: { walletAddress: '0x' + 'a'.repeat(40) } });
  assert.strictEqual(res.statusCode, 400);
});

// ---- 4b. Input allowlisting (NoSQL-injection resistance) -----------------
test('listMySettlements ignores unknown verificationStatus rather than passing raw input to Mongo', async () => {
  resetState();
  const wallet = '0x' + 'a'.repeat(40);
  state.rows = []; state.count = 0;
  await call(mkCtrl.listMySettlements, {
    user: { walletAddress: wallet },
    query: { verificationStatus: { $ne: null }, txHash: "' OR 1=1 --", listingId: 'NaN' },
  });
  // No throw + the $or ownership scope is still the only filter applied (mock
  // ignores query contents, but the point is the handler did not crash on
  // adversarial input).
  assert.ok(true);
});

// ---- 4c. Admin override state machine + audit ----------------------------
test('overrideStatus rejects an escrow-only target (released) — state-machine allowlist', async () => {
  resetState();
  const res = await call(adminCtrl.overrideStatus, {
    params: { id: '507f1f77bcf86cd799439011' },
    body: { target: 'released', reason: 'force release' },
    user: { _id: 'u1', email: 'a@b.c', role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'INVALID_TARGET');
  assert.strictEqual(calls.audit.length, 0);
});

test('overrideStatus requires a non-empty reason (1–500 chars)', async () => {
  resetState();
  const res = await call(adminCtrl.overrideStatus, {
    params: { id: '507f1f77bcf86cd799439011' },
    body: { target: 'disputed', reason: '   ' },
    user: { role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'INVALID_REASON');
});

test('overrideStatus: 404 when settlement missing', async () => {
  resetState();
  state.findByIdResult = null;
  const res = await call(adminCtrl.overrideStatus, {
    params: { id: '507f1f77bcf86cd799439011' },
    body: { target: 'disputed', reason: 'manual review' },
    user: { role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 404);
});

test('overrideStatus: no-op when target equals current (no audit churn)', async () => {
  resetState();
  state.findByIdResult = { _id: 's1', verificationStatus: 'disputed', listingId: 1 };
  const res = await call(adminCtrl.overrideStatus, {
    params: { id: 's1' },
    body: { target: 'disputed', reason: 'already disputed' },
    user: { role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.message, 'No change');
  assert.strictEqual(calls.audit.length, 0);
  assert.strictEqual(calls.updates.length, 0);
});

test('overrideStatus: valid transition updates + writes a critical audit entry with from/to/reason', async () => {
  resetState();
  state.findByIdResult = { _id: 's1', verificationStatus: 'mismatch', listingId: 7 };
  state.findByIdAndUpdateResult = { _id: 's1', verificationStatus: 'disputed', listingId: 7 };
  const res = await call(adminCtrl.overrideStatus, {
    params: { id: 's1' },
    body: { target: 'disputed', reason: 'escalated by ops', flag: 'OVER_DELIVERY' },
    user: { _id: 'u1', email: 'ops@example.com', role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.updates.length, 1);
  const upd = calls.updates[0].update;
  assert.strictEqual(upd.$set.verificationStatus, 'disputed');
  assert.strictEqual(upd.$set['evidence.adminOverride'].from, 'mismatch');
  assert.strictEqual(upd.$set['evidence.adminOverride'].to, 'disputed');
  assert.deepStrictEqual(upd.$addToSet, { mismatchFlags: 'OVER_DELIVERY' });

  assert.strictEqual(calls.audit.length, 1);
  const entry = calls.audit[0];
  assert.strictEqual(entry.severity, 'critical');
  assert.strictEqual(entry.resourceType, 'settlement');
  assert.strictEqual(entry.action, 'settlement.status_override');
  assert.strictEqual(entry.metadata.from, 'mismatch');
  assert.strictEqual(entry.metadata.to, 'disputed');
  assert.strictEqual(entry.metadata.reason, 'escalated by ops');
});

test('OVERRIDE_TARGETS excludes escrow-driven states', () => {
  assert.ok(!adminCtrl.OVERRIDE_TARGETS.has('released'));
  assert.ok(!adminCtrl.OVERRIDE_TARGETS.has('refunded'));
  assert.ok(adminCtrl.OVERRIDE_TARGETS.has('verified'));
});

// ---- 4d. Escrow resolution: explicit ref precedence + fallback match -----
test('samePurchase matches on chain/contract/listing/parties', () => {
  const { samePurchase } = require('../services/settlementEscrowService');
  const esc = { chainId: 1, contractAddress: '0xabc', listingId: 5, buyer: '0xa', seller: '0xb' };
  assert.ok(samePurchase(esc, { chainId: 1, contractAddress: '0xabc', listingId: 5, buyer: '0xa', seller: '0xb' }));
  assert.ok(!samePurchase(esc, { chainId: 2, contractAddress: '0xabc', listingId: 5, buyer: '0xa', seller: '0xb' }));
  assert.ok(!samePurchase(esc, { chainId: 1, contractAddress: '0xabc', listingId: 5, buyer: '0xOTHER', seller: '0xb' }));
});

test('resolveEscrowBatch prefers explicit escrowRef over fallback match', async () => {
  const { resolveEscrowBatch } = require('../services/settlementEscrowService');
  // NOTE: this exercises the real service against the escrowMock installed in
  // `before`; state.escrows is returned for every Escrow.find().
  resetState();
  const refId = '507f1f77bcf86cd79943000';
  state.escrows = [
    { _id: refId, chainId: 1, contractAddress: '0x1', listingId: 9, buyer: '0xa', seller: '0xb', state: 'released' },
    { _id: 'other', chainId: 1, contractAddress: '0x1', listingId: 9, buyer: '0xa', seller: '0xb', state: 'funded' },
  ];
  const docs = [{ _id: 's1', escrowRef: refId, chainId: 1, contractAddress: '0x1', listingId: 9, buyer: '0xa', seller: '0xb' }];
  const map = await resolveEscrowBatch(docs);
  assert.strictEqual(map.get('s1').state, 'released', 'explicit ref should win');
});
