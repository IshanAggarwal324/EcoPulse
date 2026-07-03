const { test } = require('node:test');
const assert = require('node:assert');
const {
  isPrivileged,
  allowedNodeTypesForRole,
  assertNodeTypeAllowedForRole,
  resolveCreateOwner,
  buildNodeListFilter,
  assertNodeAccess,
} = require('../utils/nodeOwnership');
const ApiError = require('../utils/apiError');

const assertThrowsApi = (fn, statusCode, code) => {
  assert.throws(fn, (err) => err instanceof ApiError
    && err.statusCode === statusCode
    && err.code === code);
};

// ---- isPrivileged (now delegates to auth/roles) ---------------------------
test('isPrivileged is true only for admin/moderator', () => {
  assert.ok(isPrivileged({ role: 'admin' }));
  assert.ok(isPrivileged({ role: 'moderator' }));
  assert.ok(!isPrivileged({ role: 'consumer' }));
  assert.ok(!isPrivileged({ role: 'prosumer' }));
  assert.ok(!isPrivileged({ role: 'grid_operator' }));
  assert.ok(!isPrivileged({ role: 'user' })); // legacy
  assert.ok(!isPrivileged(undefined));
});

// ---- allowedNodeTypesForRole ---------------------------------------------
test('consumer may only create consumer nodes; prosumer may create any; operator none; admin/moderator any', () => {
  assert.deepStrictEqual(allowedNodeTypesForRole('consumer'), ['consumer']);
  assert.deepStrictEqual(allowedNodeTypesForRole('prosumer'), ['producer', 'consumer', 'prosumer']);
  assert.deepStrictEqual(allowedNodeTypesForRole('grid_operator'), []);
  assert.strictEqual(allowedNodeTypesForRole('admin'), null); // null = any
  assert.strictEqual(allowedNodeTypesForRole('moderator'), null);
  assert.deepStrictEqual(allowedNodeTypesForRole('ghost'), []); // unknown => none
});

// ---- assertNodeTypeAllowedForRole ----------------------------------------
test('consumer cannot create a producer node (policy violation rejected)', () => {
  assertThrowsApi(
    () => assertNodeTypeAllowedForRole('consumer', 'producer'),
    403,
    'NODE_TYPE_NOT_ALLOWED',
  );
});

test('prosumer may create producer/consumer/prosumer nodes', () => {
  assertNodeTypeAllowedForRole('prosumer', 'producer'); // does not throw
  assertNodeTypeAllowedForRole('prosumer', 'consumer');
  assertNodeTypeAllowedForRole('prosumer', 'prosumer');
});

test('admin/moderator bypass the node-type check (any type allowed)', () => {
  assertNodeTypeAllowedForRole('admin', 'producer');
  assertNodeTypeAllowedForRole('moderator', 'producer');
});

test('grid_operator cannot create any node type', () => {
  assertThrowsApi(
    () => assertNodeTypeAllowedForRole('grid_operator', 'consumer'),
    403,
    'NODE_TYPE_NOT_ALLOWED',
  );
});

test('unknown role is rejected (fail-closed)', () => {
  assertThrowsApi(
    () => assertNodeTypeAllowedForRole('ghost', 'consumer'),
    403,
    'NODE_TYPE_NOT_ALLOWED',
  );
});

// ---- resolveCreateOwner (createNode IDOR fix) ----------------------------
test('non-privileged user ALWAYS owns the node; request-supplied userId is ignored', () => {
  const attackerId = '507f1f77bcf86cd799439011';
  const victimId = '507f1f77bcf86cd799439012';

  // consumer tries to create a node "for" another user
  const owner = resolveCreateOwner({ role: 'consumer', _id: attackerId }, victimId);
  assert.strictEqual(owner, attackerId); // victim id ignored
});

test('admin may create a node on behalf of a specified user', () => {
  const adminId = '507f1f77bcf86cd799439011';
  const targetId = '507f1f77bcf86cd799439012';
  const owner = resolveCreateOwner({ role: 'admin', _id: adminId }, targetId);
  assert.strictEqual(owner, targetId);
});

test('admin without a target owns the node themselves', () => {
  const adminId = '507f1f77bcf86cd799439011';
  const owner = resolveCreateOwner({ role: 'admin', _id: adminId }, undefined);
  assert.strictEqual(owner, adminId);
});

test('admin target with an invalid objectId falls back to self', () => {
  const adminId = '507f1f77bcf86cd799439011';
  const owner = resolveCreateOwner({ role: 'admin', _id: adminId }, 'not-an-id');
  assert.strictEqual(owner, adminId);
});

test('missing user yields null owner (controller rejects)', () => {
  assert.strictEqual(resolveCreateOwner(undefined, '507f1f77bcf86cd799439012'), null);
});

// ---- buildNodeListFilter --------------------------------------------------
test('privileged roles see all nodes (empty filter)', () => {
  assert.deepStrictEqual(buildNodeListFilter({ role: 'admin', _id: 'a' }), {});
  assert.deepStrictEqual(buildNodeListFilter({ role: 'moderator', _id: 'm' }), {});
});

test('non-privileged roles are scoped to their own nodes', () => {
  const uid = '507f1f77bcf86cd799439011';
  for (const role of ['consumer', 'prosumer', 'grid_operator']) {
    assert.deepStrictEqual(buildNodeListFilter({ role, _id: uid }), { userId: uid });
  }
});

test('buildNodeListFilter throws 401 when no user', () => {
  assertThrowsApi(() => buildNodeListFilter(undefined), 401, 'NOT_AUTHORIZED');
  assertThrowsApi(() => buildNodeListFilter({}), 401, 'NOT_AUTHORIZED');
});

// ---- assertNodeAccess (GET /nodes/:id IDOR fix) --------------------------
test('owner passes the access check', () => {
  const uid = '507f1f77bcf86cd799439011';
  assertNodeAccess({ role: 'consumer', _id: uid }, { userId: uid }); // does not throw
});

test('privileged roles pass regardless of ownership', () => {
  const node = { userId: '507f1f77bcf86cd799439099' };
  assertNodeAccess({ role: 'admin', _id: '507f1f77bcf86cd799439011' }, node);
  assertNodeAccess({ role: 'moderator', _id: '507f1f77bcf86cd799439011' }, node);
});

test('non-owner is denied and existence is hidden (404, not 403)', () => {
  // 404 instead of 403 prevents leaking the existence of another user's node.
  assertThrowsApi(
    () => assertNodeAccess(
      { role: 'consumer', _id: '507f1f77bcf86cd799439011' },
      { userId: '507f1f77bcf86cd799439099' },
    ),
    404,
    'NODE_NOT_FOUND',
  );
});

test('missing node is reported as not found', () => {
  assertThrowsApi(
    () => assertNodeAccess({ role: 'admin', _id: 'a' }, null),
    404,
    'NODE_NOT_FOUND',
  );
});

test('grid_operator cannot read another user node via the generic access path (only owner/privileged)', () => {
  assertThrowsApi(
    () => assertNodeAccess(
      { role: 'grid_operator', _id: '507f1f77bcf86cd799439011' },
      { userId: '507f1f77bcf86cd799439099' },
    ),
    404,
    'NODE_NOT_FOUND',
  );
});
