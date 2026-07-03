const { test } = require('node:test');
const assert = require('node:assert');
const { requirePermission } = require('../middleware/requirePermission');
const P = require('../auth/permissions');

const run = (middleware, role) => {
  let status;
  let body;
  let nextCalled = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  const next = () => {
    nextCalled = true;
  };
  middleware({ user: role === undefined ? undefined : { role } }, res, next);
  return { status, body, nextCalled };
};

test('grants when the role holds the required permission', () => {
  const mw = requirePermission(P.NODES_CREATE);
  const { status, nextCalled } = run(mw, 'prosumer');
  assert.strictEqual(status, undefined); // no error response sent
  assert.ok(nextCalled);
});

test('admin wildcard passes every permission', () => {
  const mw = requirePermission(P.CARBON_AWARD);
  const { status, nextCalled } = run(mw, 'admin');
  assert.strictEqual(status, undefined);
  assert.ok(nextCalled);
});

test('denies (403) when the role lacks the permission', () => {
  const mw = requirePermission(P.NODES_CREATE);
  const { status, body } = run(mw, 'grid_operator');
  assert.strictEqual(status, 403);
  assert.strictEqual(body.code, 'FORBIDDEN');
});

test('denies (403) for an unknown / legacy role (fail-closed)', () => {
  const mw = requirePermission(P.NODES_READ_OWN);
  const { status, body } = run(mw, 'user'); // legacy value, no longer mapped
  assert.strictEqual(status, 403);
  assert.strictEqual(body.code, 'FORBIDDEN');
});

test('returns 401 when there is no authenticated user', () => {
  const mw = requirePermission(P.NODES_READ_OWN);
  const { status, body } = run(mw, undefined);
  assert.strictEqual(status, 401);
  assert.strictEqual(body.code, 'NOT_AUTHORIZED');
});

test('multiple permissions are OR-ed (any one grants access)', () => {
  const mw = requirePermission(P.NODES_READ_OWN, P.NODES_READ_ZONE, P.NODES_READ_ALL);

  // grid_operator holds nodes:read:zone
  const op = run(mw, 'grid_operator');
  assert.strictEqual(op.status, undefined);
  assert.ok(op.nextCalled);

  // consumer holds nodes:read:own
  const c = run(mw, 'consumer');
  assert.strictEqual(c.status, undefined);
  assert.ok(c.nextCalled);

  // moderator holds nodes:read:all
  const m = run(mw, 'moderator');
  assert.strictEqual(m.status, undefined);
  assert.ok(m.nextCalled);
});

test('constructor throws if no permission is supplied (misconfiguration guard)', () => {
  assert.throws(() => requirePermission(), /at least one permission/);
});
