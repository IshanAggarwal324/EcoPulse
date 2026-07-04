/**
 * Module 8.4 — wallet↔user linking configuration.
 *
 * The wallet address is the single source of truth for carbon balances,
 * settlements and trades, so binding it to an app account is a security-critical
 * operation. It MUST be proven with an EIP-712 signature (the server never holds
 * a private key) and replay-protected with a single-use, expiring challenge.
 *
 * Conventions:
 *   - FAIL-CLOSED: a missing/invalid env never widens access; it narrows it.
 *   - The EIP-712 domain binds signatures to EcoPulse + the expected chain so a
 *     signature captured here cannot be replayed against another dapp or chain.
 *   - No verifyingContract: wallet linking is an off-chain identity attestation,
 *     not an on-chain call, so the domain intentionally omits it. The signer and
 *     verifier use an identical partial domain, which EIP-712 permits.
 */
const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// EIP-712 domain (distinct from the auto-trading domain so a wallet-link
// signature can never authorize a listing intent, and vice versa).
const WALLET_LINK_DOMAIN_NAME = 'EcoPulse Wallet Link';
const WALLET_LINK_DOMAIN_VERSION = '1';

// Chain id used for server-side verification. Must match the signer (frontend
// uses EXPECTED_CHAIN_ID). Falls back to a local dev chain id for tests.
const getChainId = () => {
  const parsed = parseInt(process.env.VITE_CHAIN_ID || process.env.CHAIN_ID || '31337', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 31337;
};

// How long an issued challenge remains valid. Short to limit the replay window.
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const getChallengeTtlMs = () =>
  toPositiveInt(process.env.WALLET_LINK_CHALLENGE_TTL_MS, DEFAULT_CHALLENGE_TTL_MS);

// Cooldown applied after a failed link attempt on a challenge, to make
// signature brute-force / nonce enumeration impractical (paired with rate
// limiting at the route layer).
const DEFAULT_FAILED_ATTEMPT_LOCK_MS = 30 * 1000;
const getFailedAttemptLockMs = () =>
  toPositiveInt(process.env.WALLET_LINK_FAILED_LOCK_MS, DEFAULT_FAILED_ATTEMPT_LOCK_MS);

module.exports = {
  WALLET_LINK_DOMAIN_NAME,
  WALLET_LINK_DOMAIN_VERSION,
  getChainId,
  getChallengeTtlMs,
  DEFAULT_CHALLENGE_TTL_MS,
  getFailedAttemptLockMs,
  DEFAULT_FAILED_ATTEMPT_LOCK_MS,
};
