const { test } = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');

/*
 * Regression: verified users kept seeing the "Verify your email" banner.
 *
 * `isEmailVerified` (and `mustChangePassword`) used to be `select: false`.
 * /auth/me selected them explicitly, but login, token refresh, profile update
 * and wallet link/unlink loaded the user without them and serialized
 * `user.isEmailVerified ?? false` -> `false`, overwriting the client's state.
 */

test('isEmailVerified and mustChangePassword are returned by default queries', () => {
  for (const path of ['isEmailVerified', 'mustChangePassword']) {
    const schemaType = User.schema.path(path);
    assert.ok(schemaType, `${path} should exist on the User schema`);
    assert.notEqual(
      schemaType.selected,
      false,
      `${path} must not be select:false, or any query that omits "+${path}" reports false`,
    );
  }
});

test('secrets stay hidden by default', () => {
  for (const path of [
    'password',
    'emailVerificationToken',
    'refreshTokenVersion',
    'accessTokenVersion',
  ]) {
    assert.equal(User.schema.path(path).selected, false, `${path} must remain select:false`);
  }
});

test('a hydrated verified user keeps isEmailVerified=true', () => {
  const doc = User.hydrate({
    _id: '507f1f77bcf86cd799439011',
    name: 'Ada',
    email: 'ada@example.com',
    isEmailVerified: true,
    mustChangePassword: true,
  });
  assert.equal(doc.isEmailVerified, true);
  assert.equal(doc.mustChangePassword, true);
});

/* ------------------------------------------------------------------ */
/* Wallet link response must describe the user, not { user, signer }   */
/* ------------------------------------------------------------------ */

test('POST /auth/wallet/link responds with the linked user and audits the right actor', async () => {
  const walletLink = require('../services/walletLinkService');
  const auditService = require('../services/auditService');
  const { linkWallet } = require('../controllers/walletLinkController');

  const linkedUser = {
    _id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    walletAddress: '0xabc0000000000000000000000000000000000001',
    isEmailVerified: true,
    mustChangePassword: false,
  };

  const origLink = walletLink.linkWallet;
  const origLog = auditService.log;
  const audits = [];
  walletLink.linkWallet = async () => ({ user: linkedUser, signer: '0xsigner' });
  auditService.log = async (entry) => {
    audits.push(entry);
  };

  try {
    const body = await new Promise((resolve, reject) => {
      const res = {
        status() {
          return this;
        },
        json: resolve,
      };
      linkWallet({ user: { _id: 'u1' }, body: { wallet: linkedUser.walletAddress, signature: '0x1' } }, res, reject);
    });

    assert.equal(body.success, true);
    assert.equal(body.data.user.email, 'ada@example.com');
    assert.equal(body.data.user.walletAddress, linkedUser.walletAddress);
    assert.equal(body.data.user.isEmailVerified, true);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'WALLET_LINKED');
    assert.equal(audits[0].resourceId, 'u1');
    assert.equal(audits[0].actor, linkedUser);
  } finally {
    walletLink.linkWallet = origLink;
    auditService.log = origLog;
  }
});
