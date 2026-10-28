process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(40);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { generateAccessToken } = require('../utils/tokens');

/*
 * Regression: after isEmailVerified/mustChangePassword stopped being
 * select:false, protect() still asked for them with `+field` alongside
 * `-password`. Mongoose only strips the `+` for schema-excluded paths, so the
 * projection sent to MongoDB contained a literal "+isEmailVerified" key mixed
 * with exclusions, MongoDB rejected it, and every authenticated request
 * returned 401 "Not authorized, token invalid".
 *
 * No database: the lookup is stubbed, but the select() string protect() uses
 * is replayed through a real Mongoose query to inspect the projection.
 */

const ID = '507f1f77bcf86cd799439011';

const runProtect = async () => {
  let selectArg = null;
  const fakeUser = {
    _id: ID,
    role: 'user',
    isEmailVerified: true,
    mustChangePassword: false,
    accessTokenVersion: 0,
  };

  const original = User.findById;
  User.findById = () => ({
    select(arg) {
      selectArg = arg;
      return Promise.resolve(fakeUser);
    },
  });

  try {
    const req = { headers: { authorization: `Bearer ${generateAccessToken(ID, 0)}` } };
    let status = null;
    let body = null;
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
    let nextCalled = false;
    await protect(req, res, () => {
      nextCalled = true;
    });
    return { req, status, body, nextCalled, selectArg, fakeUser };
  } finally {
    User.findById = original;
  }
};

test('protect() authenticates a valid token and attaches the user', async () => {
  const { req, nextCalled, status, body, fakeUser } = await runProtect();
  assert.equal(status, null, `unexpected response: ${JSON.stringify(body)}`);
  assert.equal(nextCalled, true);
  assert.equal(req.user, fakeUser);
});

test('protect() builds a valid MongoDB projection (no literal "+field" keys, no mixed modes)', async () => {
  const { selectArg } = await runProtect();
  assert.ok(selectArg, 'protect() should call .select()');

  const query = User.findById(ID).select(selectArg);
  query._applyPaths();
  const fields = query._fields;

  const literalPlusKeys = Object.keys(fields).filter((key) => key.startsWith('+'));
  assert.deepEqual(literalPlusKeys, [], `projection has literal "+" keys: ${JSON.stringify(fields)}`);

  const values = new Set(Object.values(fields));
  assert.ok(!(values.has(0) && values.has(1)), `mixed inclusion/exclusion: ${JSON.stringify(fields)}`);

  // The fields the rest of the app reads off req.user must come back.
  assert.equal(fields.password, 0, 'password must stay excluded');
  assert.notEqual(fields.accessTokenVersion, 0, 'accessTokenVersion is needed for revocation checks');
  assert.notEqual(fields.isEmailVerified, 0, 'isEmailVerified is needed by requireEmailVerified');
  assert.notEqual(fields.mustChangePassword, 0, 'mustChangePassword is needed by requirePasswordCurrent');
});
