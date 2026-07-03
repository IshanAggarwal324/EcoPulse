const { test } = require('node:test');
const assert = require('node:assert');
const {
  ROLES,
  ALL_ROLES,
  DEFAULT_ROLE,
  LEGACY_ROLE_MAP,
  normalizeLegacyRole,
  isValidRole,
  isPrivilegedRole,
  ROLE_PERMISSIONS,
  rolePermissions,
  hasPermission,
} = require('../auth/roles');

test('all five domain roles are present and unique', () => {
  assert.deepStrictEqual(ALL_ROLES.sort(), [
    'admin',
    'consumer',
    'grid_operator',
    'moderator',
    'prosumer',
  ]);
});

test('default role is consumer (the least-privileged base persona)', () => {
  assert.strictEqual(DEFAULT_ROLE, 'consumer');
});

test('legacy "user" role maps onto consumer; privileged roles are preserved', () => {
  assert.strictEqual(LEGACY_ROLE_MAP.user, 'consumer');
  assert.strictEqual(normalizeLegacyRole('user'), 'consumer');
  assert.strictEqual(normalizeLegacyRole('admin'), 'admin');
  assert.strictEqual(normalizeLegacyRole('moderator'), 'moderator');
  // already-migrated roles pass through unchanged
  assert.strictEqual(normalizeLegacyRole('prosumer'), 'prosumer');
});

test('normalizeLegacyRole tolerates non-string / missing input', () => {
  assert.strictEqual(normalizeLegacyRole(undefined), undefined);
  assert.strictEqual(normalizeLegacyRole(null), null);
  assert.strictEqual(normalizeLegacyRole(123), 123);
});

test('isValidRole whitelists only the known roles', () => {
  assert.ok(isValidRole('consumer'));
  assert.ok(isValidRole('grid_operator'));
  assert.ok(isValidRole('admin'));
  assert.ok(!isValidRole('user')); // legacy value is NOT valid after migration
  assert.ok(!isValidRole('superuser'));
  assert.ok(!isValidRole(undefined));
});

test('admin is the wildcard (holds every permission) and is privileged', () => {
  assert.strictEqual(ROLE_PERMISSIONS.admin, '*');
  assert.strictEqual(rolePermissions('admin'), null); // null => all
  assert.ok(hasPermission('admin', 'nodes:create'));
  assert.ok(hasPermission('admin', 'carbon:award'));
  assert.ok(hasPermission('admin', 'a:new:permission:that:did:not:exist'));
  assert.ok(isPrivilegedRole('admin'));
});

test('moderator is privileged but not a wildcard', () => {
  assert.ok(isPrivilegedRole('moderator'));
  assert.ok(Array.isArray(rolePermissions('moderator')));
  assert.ok(hasPermission('moderator', 'analytics:read:global'));
  assert.ok(!hasPermission('moderator', 'nodes:create')); // moderators cannot create nodes
  assert.ok(!hasPermission('moderator', 'carbon:award'));
});

test('grid_operator is NOT privileged (zone-scoped, not global)', () => {
  assert.ok(!isPrivilegedRole('grid_operator'));
  assert.ok(hasPermission('grid_operator', 'nodes:read:zone'));
  assert.ok(hasPermission('grid_operator', 'analytics:read:zone'));
  // operators cannot mutate nodes or trade
  assert.ok(!hasPermission('grid_operator', 'nodes:create'));
  assert.ok(!hasPermission('grid_operator', 'nodes:write:own'));
  assert.ok(!hasPermission('grid_operator', 'trades:execute'));
  assert.ok(!hasPermission('grid_operator', 'analytics:read:global'));
});

test('consumer/prosumer can manage their own nodes and trade, but see nothing global', () => {
  for (const role of ['consumer', 'prosumer']) {
    assert.ok(hasPermission(role, 'nodes:create'));
    assert.ok(hasPermission(role, 'nodes:read:own'));
    assert.ok(hasPermission(role, 'nodes:write:own'));
    assert.ok(hasPermission(role, 'nodes:delete:own'));
    assert.ok(hasPermission(role, 'trades:execute'));
    assert.ok(!hasPermission(role, 'nodes:read:all'));
    assert.ok(!hasPermission(role, 'analytics:read:global'));
    assert.ok(!isPrivilegedRole(role));
  }
});

test('consumer cannot create a producer node (checked elsewhere) but prosumer has create', () => {
  // nodeType-vs-role enforcement is in nodeOwnership; here we only assert the
  // underlying create permission is identical for consumer and prosumer.
  assert.ok(hasPermission('consumer', 'nodes:create'));
  assert.ok(hasPermission('prosumer', 'nodes:create'));
});

test('unknown / missing role fails closed (no permissions)', () => {
  assert.deepStrictEqual(rolePermissions('user'), []); // legacy value => []
  assert.deepStrictEqual(rolePermissions('ghost'), []);
  assert.deepStrictEqual(rolePermissions(undefined), []);
  assert.ok(!hasPermission('ghost', 'nodes:create'));
  assert.ok(!hasPermission(undefined, 'nodes:create'));
});

test('hasPermission with no permission argument is false', () => {
  assert.ok(!hasPermission('admin', undefined));
  assert.ok(!hasPermission('admin', ''));
});
