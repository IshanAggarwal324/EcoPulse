const { test } = require('node:test');
const assert = require('node:assert');
const {
  isPrivileged,
  allowedNodeTypesForRole,
  assertNodeTypeAllowedForRole,
  resolveCreateOwner,
  buildNodeListFilter,
  buildNodeAccessFilter,
  getUserZoneIds,
  assertNodeAccess,
  assertCanManageNodeAccess,
  nodeGrantsOperatorPermission,
  sanitizeZoneId,
  sanitizeOperators,
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

// ---- buildNodeListFilter / buildNodeAccessFilter --------------------------
test('privileged roles see all nodes (empty filter)', () => {
  assert.deepStrictEqual(buildNodeListFilter({ role: 'admin', _id: 'a' }), {});
  assert.deepStrictEqual(buildNodeListFilter({ role: 'moderator', _id: 'm' }), {});
});

test('non-privileged roles see own nodes + nodes delegated to them (read scope)', () => {
  // Module 8.3 — a user may be a delegated operator on someone else's node, so
  // the list filter must include the operators clause in addition to ownership.
  const uid = '507f1f77bcf86cd799439011';
  for (const role of ['consumer', 'prosumer', 'grid_operator']) {
    assert.deepStrictEqual(buildNodeListFilter({ role, _id: uid }), {
      $or: [{ userId: uid }, { 'operators.userId': uid }],
    });
  }
});

test('write-scope filter requires a write operator match', () => {
  const uid = '507f1f77bcf86cd799439011';
  const f = buildNodeAccessFilter({ role: 'consumer', _id: uid }, { permission: 'write' });
  assert.deepStrictEqual(f, {
    $or: [{ userId: uid }, { operators: { $elemMatch: { userId: uid, permission: 'write' } } }],
  });
});

test('grid_operator with assigned zones gets a read-only zone clause', () => {
  const uid = '507f1f77bcf86cd799439011';
  const f = buildNodeAccessFilter({
    role: 'grid_operator',
    _id: uid,
    assignedZoneIds: ['North-Grid', 'north-grid', 'BAD CODE!', 'south'],
  });
  // deduped + sanitized (invalid 'BAD CODE!' dropped, case-normalized).
  assert.deepStrictEqual(f, {
    $or: [
      { userId: uid },
      { 'operators.userId': uid },
      { zoneId: { $in: ['north-grid', 'south'] } },
    ],
  });
});

test('grid_operator write filter has NO zone clause (zone access is read-only)', () => {
  const uid = '507f1f77bcf86cd799439011';
  const f = buildNodeAccessFilter(
    { role: 'grid_operator', _id: uid, assignedZoneIds: ['north'] },
    { permission: 'write' },
  );
  assert.deepStrictEqual(f, {
    $or: [
      { userId: uid },
      { operators: { $elemMatch: { userId: uid, permission: 'write' } } },
    ],
  });
});

test('buildNodeListFilter throws 401 when no user', () => {
  assertThrowsApi(() => buildNodeListFilter(undefined), 401, 'NOT_AUTHORIZED');
  assertThrowsApi(() => buildNodeListFilter({}), 401, 'NOT_AUTHORIZED');
});

test('getUserZoneIds dedupes + validates codes', () => {
  assert.deepStrictEqual(getUserZoneIds({ assignedZoneIds: ['A', 'a', 'B-C', '', null, 'x y', 'd'] }), ['a', 'b-c', 'd']);
  assert.deepStrictEqual(getUserZoneIds({}), []);
  assert.deepStrictEqual(getUserZoneIds({ assignedZoneIds: 'nope' }), []);
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
      { userId: '507f1f77bcf86cd799099' },
    ),
    404,
    'NODE_NOT_FOUND',
  );
});

// ---- assertNodeAccess: delegation + zone (Module 8.3) --------------------
const OP_ID = '507f1f77bcf86cd7994390aa';
const OTHER = '507f1f77bcf86cd799439099';
const OWNER = '507f1f77bcf86cd799439011';

test('read delegate passes a read access check', () => {
  const node = { userId: OTHER, operators: [{ userId: OP_ID, permission: 'read' }] };
  assertNodeAccess({ role: 'consumer', _id: OP_ID }, node, 'read'); // no throw
});

test('read delegate is denied write (403, not hidden 404)', () => {
  const node = { userId: OTHER, operators: [{ userId: OP_ID, permission: 'read' }] };
  assertThrowsApi(
    () => assertNodeAccess({ role: 'consumer', _id: OP_ID }, node, 'write'),
    403,
    'NODE_ACCESS_DENIED',
  );
});

test('write delegate passes both read and write access checks', () => {
  const node = { userId: OTHER, operators: [{ userId: OP_ID, permission: 'write' }] };
  assertNodeAccess({ role: 'prosumer', _id: OP_ID }, node, 'read');
  assertNodeAccess({ role: 'prosumer', _id: OP_ID }, node, 'write');
});

test('grid_operator in the node zone passes read (zone visibility)', () => {
  const node = { userId: OTHER, zoneId: 'north-grid' };
  assertNodeAccess(
    { role: 'grid_operator', _id: '507f1f77bcf86cd7994390c0', assignedZoneIds: ['north-grid'] },
    node,
    'read',
  );
});

test('grid_operator OUT of the node zone is denied read (404 hidden)', () => {
  const node = { userId: OTHER, zoneId: 'north-grid' };
  assertThrowsApi(
    () => assertNodeAccess(
      { role: 'grid_operator', _id: '507f1f77bcf86cd7994390c0', assignedZoneIds: ['south'] },
      node,
      'read',
    ),
    404,
    'NODE_NOT_FOUND',
  );
});

test('grid_operator in-zone is denied write (zone is read-only)', () => {
  const node = { userId: OTHER, zoneId: 'north-grid' };
  assertThrowsApi(
    () => assertNodeAccess(
      { role: 'grid_operator', _id: '507f1f77bcf86cd7994390c0', assignedZoneIds: ['north-grid'] },
      node,
      'write',
    ),
    404,
    'NODE_NOT_FOUND',
  );
});

test('owner passes write check', () => {
  assertNodeAccess({ role: 'consumer', _id: OWNER }, { userId: OWNER }, 'write');
});

test('node with neither ownership nor delegation is hidden (404)', () => {
  assertThrowsApi(
    () => assertNodeAccess({ role: 'consumer', _id: OWNER }, { userId: OTHER }, 'read'),
    404,
    'NODE_NOT_FOUND',
  );
});

test('assertNodeAccess rejects an invalid permission string', () => {
  assertThrowsApi(
    () => assertNodeAccess({ role: 'admin', _id: OWNER }, { userId: OWNER }, 'admin'),
    400,
    'INVALID_PERMISSION',
  );
});

test('nodeGrantsOperatorPermission helper', () => {
  const node = { operators: [{ userId: OP_ID, permission: 'read' }] };
  assert.strictEqual(nodeGrantsOperatorPermission(node, OP_ID, 'read'), true);
  assert.strictEqual(nodeGrantsOperatorPermission(node, OP_ID, 'write'), false);
  assert.strictEqual(nodeGrantsOperatorPermission(node, OTHER, 'read'), false);
  assert.strictEqual(nodeGrantsOperatorPermission({}, OP_ID, 'read'), false);
});

// ---- assertCanManageNodeAccess (operators/zone are owner+admin only) -----
test('owner can manage access surface', () => {
  assertCanManageNodeAccess({ role: 'consumer', _id: OWNER }, { userId: OWNER });
});

test('admin can manage access surface', () => {
  assertCanManageNodeAccess({ role: 'admin', _id: 'x' }, { userId: OWNER });
});

test('write delegate CANNOT manage access surface (no privilege escalation)', () => {
  const node = { userId: OTHER, operators: [{ userId: OP_ID, permission: 'write' }] };
  assertThrowsApi(
    () => assertCanManageNodeAccess({ role: 'prosumer', _id: OP_ID }, node),
    404,
    'NODE_NOT_FOUND',
  );
});

// ---- sanitizeZoneId -------------------------------------------------------
test('sanitizeZoneId lowercases, validates, clears on empty', () => {
  assert.strictEqual(sanitizeZoneId(' North-Grid '), 'north-grid');
  assert.strictEqual(sanitizeZoneId(''), null);
  assert.strictEqual(sanitizeZoneId(null), null);
  assertThrowsApi(() => sanitizeZoneId('bad code!'), 400, 'INVALID_ZONE');
  assertThrowsApi(() => sanitizeZoneId({}), 400, 'INVALID_ZONE');
  assertThrowsApi(() => sanitizeZoneId('a'.repeat(65)), 400, 'INVALID_ZONE');
});

// ---- sanitizeOperators ----------------------------------------------------
test('sanitizeOperators normalizes, dedupes, drops owner, caps length', () => {
  const op1 = '507f1f77bcf86cd7994390a1';
  const op2 = '507f1f77bcf86cd7994390a2';
  const out = sanitizeOperators(
    [
      { userId: op1, permission: 'write' },
      { userId: op2 }, // default read
      { userId: op1 }, // dup
      { userId: OWNER, permission: 'read' }, // owner -> dropped
    ],
    OWNER,
  );
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].permission, 'write');
  assert.strictEqual(out[1].permission, 'read');
  // normalized to ObjectId instances
  assert.ok(out[0].userId instanceof require('mongoose').Types.ObjectId);
});

test('sanitizeOperators accepts a single object (not just arrays)', () => {
  const op1 = '507f1f77bcf86cd7994390a1';
  const out = sanitizeOperators({ userId: op1, permission: 'read' }, OWNER);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].permission, 'read');
});

test('sanitizeOperators rejects junk + bad permission', () => {
  assertThrowsApi(() => sanitizeOperators('nope', OWNER), 400, 'INVALID_OPERATORS');
  assertThrowsApi(() => sanitizeOperators([{ userId: 'bad' }], OWNER), 400, 'INVALID_OPERATORS');
  assertThrowsApi(
    () => sanitizeOperators([{ userId: '507f1f77bcf86cd7994390a1', permission: 'delete' }], OWNER),
    400,
    'INVALID_OPERATORS',
  );
});

test('sanitizeOperators returns null when absent (distinguish from explicit clear)', () => {
  assert.strictEqual(sanitizeOperators(undefined, OWNER), null);
  assert.deepStrictEqual(sanitizeOperators([], OWNER), []);
});
