/**
 * Wallet ↔ user linking service (Module 8.4).
 *
 * Cryptographically proves that a connected wallet controls the private key for
 * the address being claimed as `User.walletAddress`. The backend NEVER holds a
 * private key. The flow is:
 *
 *   1. GET  /auth/wallet/challenge  — server mints a single-use nonce bound to
 *      (user, wallet) and returns EIP-712 typed data. The nonce + issuedAt are
 *      server-generated and stored; the client may NOT override them.
 *   2. POST /auth/wallet/link       — client returns a signature. The server
 *      REBUILDS the canonical typed data from its OWN stored challenge values
 *      (never trusting client-supplied nonce/issuedAt), recovers the signer, and
 *      asserts it equals the declared wallet. The nonce is single-use + expiry
 *      checked. On success the wallet is atomically claimed.
 *   3. DELETE /auth/wallet/unlink   — clears the link. Self-service requires
 *      password re-authentication (token-theft can't unlink without it); admins
 *      may unlink any user.
 *
 * Security model (defense in depth):
 *   - Replay: nonce is random, single-use, server-stored, short-TTL.
 *   - Malleability: ethers enforces EIP-2 low-s; malformed sigs recover to null.
 *   - Cross-account replay: the message binds `userId`, and the nonce lives on
 *     the requesting user's doc — a signature minted for user A cannot link to
 *     user B because the rebuild uses B's stored nonce (which won't match).
 *   - Cross-action replay: the `action` field ('link') is part of the signed
 *     digest, so this signature can't authorize a different operation.
 *   - Cross-dapp/chain replay: the EIP-712 domain binds to EcoPulse + chainId.
 *   - Duplicate claim: app-level pre-check + a unique sparse DB index.
 *   - Case: all addresses normalized to lowercase before storage + comparison.
 */

const { ethers } = require('ethers');
const crypto = require('crypto');
const User = require('../models/User');
const ApiError = require('../utils/apiError');
const {
  WALLET_LINK_DOMAIN_NAME,
  WALLET_LINK_DOMAIN_VERSION,
  getChainId,
  getChallengeTtlMs,
  getFailedAttemptLockMs,
} = require('../config/walletLink');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const WALLET_LINK_ACTION = 'link';

/**
 * Canonical EIP-712 type schema. Signer (frontend) and verifier (here) MUST use
 * this exact schema. Exposed via the challenge endpoint so the frontend never
 * hardcodes it.
 */
const WALLET_LINK_TYPES = {
  EcoPulseWalletLink: [
    { name: 'wallet', type: 'address' },
    { name: 'userId', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
};

/**
 * @returns {string} a fresh 32-byte random hex nonce (fits in uint256).
 */
function generateNonce() {
  return '0x' + crypto.randomBytes(32).toString('hex');
}

/**
 * Build the canonical EIP-712 typed data from the SECURITY-CRITICAL values.
 * `nonce`/`issuedAtUnix` MUST come from the server's stored challenge on verify
 * (or be freshly minted on issue), never from client input.
 */
function buildWalletLinkTypedData({ wallet, userId, action, nonce, issuedAtUnix }) {
  const domain = {
    name: WALLET_LINK_DOMAIN_NAME,
    version: WALLET_LINK_DOMAIN_VERSION,
    chainId: getChainId(),
  };

  const message = {
    wallet: String(wallet).toLowerCase(),
    userId: String(userId),
    action: String(action),
    nonce: typeof nonce === 'bigint' ? nonce : BigInt(String(nonce)),
    issuedAt: BigInt(Math.max(0, Math.floor(Number(issuedAtUnix)))),
  };

  return {
    types: WALLET_LINK_TYPES,
    primaryType: 'EcoPulseWalletLink',
    domain,
    message,
  };
}

/**
 * JSON-safe view (bigints -> strings) for transport to the client and logging.
 */
function wireTypedData(typedData) {
  return {
    types: typedData.types,
    primaryType: typedData.primaryType,
    domain: typedData.domain,
    message: {
      wallet: typedData.message.wallet,
      userId: typedData.message.userId,
      action: typedData.message.action,
      nonce: typedData.message.nonce.toString(),
      issuedAt: typedData.message.issuedAt.toString(),
    },
  };
}

/**
 * Recover the signer of a wallet-link signature over the canonical typed data.
 * Returns the lowercase address, or null if the signature is malformed.
 */
function recoverWalletLinkSigner(typedData, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return null;
  try {
    return ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      signature,
    ).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verify a signature against the canonical rebuild of the challenge values.
 * Throws a structured ApiError on any mismatch (malformed sig, signer mismatch).
 * @returns {{signer:string, typedData:object}}
 */
function verifyWalletLinkSignature({ wallet, userId, action, nonce, issuedAtUnix, signature }) {
  const normalized = String(wallet || '').toLowerCase();
  if (!ADDRESS_RE.test(normalized)) {
    throw new ApiError('A valid wallet address is required', 400, 'INVALID_WALLET');
  }

  const typedData = buildWalletLinkTypedData({
    wallet: normalized,
    userId,
    action,
    nonce,
    issuedAtUnix,
  });

  const recovered = recoverWalletLinkSigner(typedData, signature);
  if (!recovered) {
    throw new ApiError('Malformed signature', 400, 'MALFORMED_SIGNATURE');
  }

  if (recovered !== normalized) {
    throw new ApiError(
      'Signature signer does not match the wallet address. Reconnect the correct wallet and sign again.',
      403,
      'SIGNER_MISMATCH',
    );
  }

  return { signer: recovered, typedData };
}

/**
 * Issue a fresh single-use challenge bound to (user, wallet). Overwrites any
 * prior pending challenge. Rejects wallets already linked to another account.
 */
async function issueChallenge(user, wallet) {
  const normalized = String(wallet || '').trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) {
    throw new ApiError('A valid wallet address is required', 400, 'INVALID_WALLET');
  }

  // Fail fast: if this wallet is already cryptographically linked elsewhere, do
  // not even mint a challenge (prevents probing). Comparisons are lowercased.
  const owner = await User.findOne({ walletAddress: normalized }).select('_id').lean();
  if (owner && String(owner._id) !== String(user._id)) {
    throw new ApiError(
      'This wallet is already linked to another account',
      409,
      'WALLET_ALREADY_LINKED',
    );
  }

  const nonce = generateNonce();
  const now = Date.now();
  const ttl = getChallengeTtlMs();
  const issuedAtUnix = Math.floor(now / 1000);

  const typedData = buildWalletLinkTypedData({
    wallet: normalized,
    userId: String(user._id),
    action: WALLET_LINK_ACTION,
    nonce,
    issuedAtUnix,
  });

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        walletLinkChallenge: {
          nonce,
          wallet: normalized,
          issuedAt: new Date(now),
          expiresAt: new Date(now + ttl),
        },
      },
    },
  );

  return {
    typedData: wireTypedData(typedData),
    expiresAt: new Date(now + ttl).toISOString(),
  };
}

/**
 * Consume a challenge signature and atomically link the wallet to the user.
 *
 * The canonical typed data is rebuilt from the SERVER-STORED challenge (nonce,
 * issuedAt, wallet, userId) — the client may only supply `{ wallet, signature }`.
 * This means a client cannot declare a different nonce/action/timestamp; the
 * signature must match exactly what the server minted.
 */
async function linkWallet(user, { wallet, signature }) {
  const normalized = String(wallet || '').trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) {
    throw new ApiError('A valid wallet address is required', 400, 'INVALID_WALLET');
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new ApiError('A signature is required', 400, 'MALFORMED_SIGNATURE');
  }

  // Reload with the hidden challenge subdoc.
  const fresh = await User.findById(user._id).select('+walletLinkChallenge');
  if (!fresh) {
    throw new ApiError('Authentication required', 401, 'NOT_AUTHORIZED');
  }

  const challenge = fresh.walletLinkChallenge;
  const now = Date.now();

  // No pending challenge.
  if (!challenge || !challenge.nonce || !challenge.wallet) {
    throw new ApiError('No pending wallet-link challenge. Request a new one.', 400, 'NO_CHALLENGE');
  }
  // Challenge expired.
  if (!challenge.expiresAt || challenge.expiresAt.getTime() <= now) {
    throw new ApiError('Challenge expired. Request a new one.', 400, 'CHALLENGE_EXPIRED');
  }
  // The wallet in the link request must match the one the challenge was minted
  // for (defense in depth against swapping wallets between challenge + link).
  if (challenge.wallet.toLowerCase() !== normalized) {
    throw new ApiError('Wallet does not match the issued challenge', 400, 'WALLET_MISMATCH');
  }

  // Rebuild from the STORED server values (not client input) and verify.
  const issuedAtUnix = Math.floor((challenge.issuedAt?.getTime?.() || now) / 1000);
  const { signer, typedData } = verifyWalletLinkSignature({
    wallet: normalized,
    userId: String(fresh._id),
    action: WALLET_LINK_ACTION,
    nonce: challenge.nonce,
    issuedAtUnix,
    signature,
  });

  // Duplicate claim guard (the unique index is the hard backstop; this gives a
  // clean 409 before relying on a dup-key error).
  const owner = await User.findOne({ walletAddress: normalized }).select('_id').lean();
  if (owner && String(owner._id) !== String(fresh._id)) {
    throw new ApiError(
      'This wallet is already linked to another account',
      409,
      'WALLET_ALREADY_LINKED',
    );
  }

  // Atomic claim: only proceed if the challenge is still the one we read (guards
  // a concurrent re-issue / re-link race). On success, clear the challenge and
  // stamp the attestation fields.
  const updated = await User.findOneAndUpdate(
    { _id: fresh._id, 'walletLinkChallenge.nonce': challenge.nonce },
    {
      $set: {
        walletAddress: normalized,
        walletLinkedAt: new Date(),
        walletLinkSignature: String(signature),
        walletLinkChallenge: { nonce: null, wallet: null, issuedAt: null, expiresAt: null },
      },
    },
    { new: true },
  ).select('-walletLinkChallenge');

  if (!updated) {
    // Lost the race (challenge was rotated concurrently) — surface a retry.
    throw new ApiError('Challenge is no longer valid. Request a new one.', 409, 'CHALLENGE_STALE');
  }

  return { user: updated, signer };
}

/**
 * Clear a user's wallet link. Caller is responsible for the authorization
 * policy (self with password re-auth, or admin). Bumps the access-token version
 * so any session that relied on the prior wallet is invalidated promptly.
 */
async function unlinkWallet(user) {
  const updated = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        walletAddress: null,
        walletLinkedAt: null,
        walletLinkSignature: null,
        walletLinkChallenge: { nonce: null, wallet: null, issuedAt: null, expiresAt: null },
      },
      $inc: { accessTokenVersion: 1 },
    },
    { new: true },
  ).select('-walletLinkChallenge');

  return updated;
}

module.exports = {
  WALLET_LINK_ACTION,
  WALLET_LINK_TYPES,
  ADDRESS_RE,
  generateNonce,
  buildWalletLinkTypedData,
  wireTypedData,
  recoverWalletLinkSigner,
  verifyWalletLinkSignature,
  issueChallenge,
  linkWallet,
  unlinkWallet,
  getFailedAttemptLockMs,
};
