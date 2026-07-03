const { test } = require('node:test');
const assert = require('node:assert');
const { LEGACY_ROLE_MAP, normalizeLegacyRole, ALL_ROLES } = require('../auth/roles');

// Module 8.1 — the migration script maps every legacy role onto exactly one of
// the new domain roles. These tests pin the mapping so a future edit cannot
// silently change who becomes what.

test('the only legacy value that needs migration is "user"', () => {
  assert.deepStrictEqual(Object.keys(LEGACY_ROLE_MAP), ['user']);
});

test('"user" maps to consumer and the result is a valid new role', () => {
  const mapped = normalizeLegacyRole('user');
  assert.strictEqual(mapped, 'consumer');
  assert.ok(ALL_ROLES.includes(mapped));
});

test('admin and moderator are preserved verbatim (no privilege change)', () => {
  assert.strictEqual(normalizeLegacyRole('admin'), 'admin');
  assert.strictEqual(normalizeLegacyRole('moderator'), 'moderator');
});

test('already-migrated roles are a no-op (idempotency)', () => {
  for (const role of ALL_ROLES) {
    assert.strictEqual(normalizeLegacyRole(role), role);
  }
});

test('the mapping is idempotent: applying it twice yields the same value', () => {
  const once = normalizeLegacyRole('user');
  const twice = normalizeLegacyRole(once);
  assert.strictEqual(once, twice);
});

test('mapping never produces a value outside the new enum', () => {
  const legacyInputs = ['user', 'admin', 'moderator', 'consumer', 'prosumer', 'grid_operator'];
  for (const input of legacyInputs) {
    const out = normalizeLegacyRole(input);
    assert.ok(ALL_ROLES.includes(out), `${input} -> ${out} is not a valid role`);
  }
});
