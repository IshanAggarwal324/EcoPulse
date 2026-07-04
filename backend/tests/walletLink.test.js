const { test } = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

const walletLink = require('../services/walletLinkService');
const {
  buildWalletLinkTypedData,
  wireTypedData,
  recoverWalletLinkSigner,
  verifyWalletLinkSignature,
  generateNonce,
  WALLET_LINK_TYPES,
} = walletLink;

const assertThrowsApi = (fn, statusCode, code) => {
  assert.throws(fn, (err) => err.statusCode === statusCode && err.code === code);
};

// Real signer so the EIP-712 verification path is exercised end-to-end (not
// mocked). ethers v6 Wallet.signTypedData produces a spec-valid signature that
// ethers.verifyTypedData must recover.
const signerWallet = ethers.Wallet.createRandom();
const WALLET = signerWallet.address.toLowerCase();
const USER_ID = '507f1f77bcf86cd799439011';
const NONCE = '0x' + 'ab'.repeat(32);
const ISSUED_AT = 1_700_000_000;

// ---- typed data shape ------------------------------------------------------
test('EIP-712 type schema is the canonical 5-field EcoPulseWalletLink', () => {
  assert.deepStrictEqual(WALLET_LINK_TYPES.EcoPulseWalletLink, [
    { name: 'wallet', type: 'address' },
    { name: 'userId', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ]);
});

test('buildWalletLinkTypedData lowercases the wallet and bigints the uints', () => {
  const td = buildWalletLinkTypedData({
    wallet: WALLET.toUpperCase(),
    userId: USER_ID,
    action: 'link',
    nonce: NONCE,
    issuedAtUnix: ISSUED_AT,
  });
  assert.strictEqual(td.message.wallet, WALLET);
  assert.strictEqual(td.message.userId, USER_ID);
  assert.strictEqual(td.message.action, 'link');
  assert.strictEqual(typeof td.message.nonce, 'bigint');
  assert.strictEqual(typeof td.message.issuedAt, 'bigint');
  assert.strictEqual(td.primaryType, 'EcoPulseWalletLink');
});

test('wireTypedData serializes bigints to strings for JSON transport', () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const wire = wireTypedData(td);
  // Must be JSON-serializable (no BigInt left behind).
  assert.doesNotThrow(() => JSON.stringify(wire));
  assert.strictEqual(typeof wire.message.nonce, 'string');
  assert.strictEqual(typeof wire.message.issuedAt, 'string');
});

// ---- signer recovery -------------------------------------------------------
test('a valid signature recovers to the signing wallet', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  const recovered = recoverWalletLinkSigner(td, sig);
  assert.strictEqual(recovered, WALLET);
});

test('verifyWalletLinkSignature passes for a genuine signature', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  const { signer } = verifyWalletLinkSignature({
    wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: sig,
  });
  assert.strictEqual(signer, WALLET);
});

// ---- security: signer mismatch --------------------------------------------
test('a signature from a DIFFERENT wallet is rejected (SIGNER_MISMATCH)', async () => {
  const other = ethers.Wallet.createRandom();
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  // Attacker signs with their own key for the victim's wallet field.
  const sig = await other.signTypedData(td.domain, td.types, td.message);
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: sig }),
    403,
    'SIGNER_MISMATCH',
  );
});

// ---- security: replay via tampered fields (canonical rebuild) -------------
test('tampering with userId is detected (rebuild differs from what was signed)', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  // Attacker tries to attach the signature to a DIFFERENT account.
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: '507f1f77bcf86cd799439099', action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: sig }),
    403,
    'SIGNER_MISMATCH',
  );
});

test('tampering with the nonce is detected', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  const differentNonce = '0x' + 'cd'.repeat(32);
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: differentNonce, issuedAtUnix: ISSUED_AT, signature: sig }),
    403,
    'SIGNER_MISMATCH',
  );
});

test('tampering with the action is detected (cross-action replay blocked)', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: USER_ID, action: 'unlink', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: sig }),
    403,
    'SIGNER_MISMATCH',
  );
});

test('tampering with issuedAt is detected', async () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  const sig = await signerWallet.signTypedData(td.domain, td.types, td.message);
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT + 1, signature: sig }),
    403,
    'SIGNER_MISMATCH',
  );
});

// ---- security: malformed inputs -------------------------------------------
test('malformed signature returns null signer / 400', () => {
  const td = buildWalletLinkTypedData({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT });
  assert.strictEqual(recoverWalletLinkSigner(td, 'not-a-signature'), null);
  assert.strictEqual(recoverWalletLinkSigner(td, ''), null);
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: WALLET, userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: '0xdeadbeef' }),
    400,
    'MALFORMED_SIGNATURE',
  );
});

test('invalid wallet address is rejected before any crypto work', () => {
  assertThrowsApi(
    () => verifyWalletLinkSignature({ wallet: '0xdeadbeef', userId: USER_ID, action: 'link', nonce: NONCE, issuedAtUnix: ISSUED_AT, signature: '0x1234' }),
    400,
    'INVALID_WALLET',
  );
});

// ---- nonce generation ------------------------------------------------------
test('generateNonce produces a fresh 32-byte hex each call', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});
