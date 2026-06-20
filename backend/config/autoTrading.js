/**
 * Auto-Bid/Ask matcher configuration (Sub-module 2.3).
 *
 * Centralizes every env-driven knob for the auto-listing engine so the
 * worker, service, controller, and intent verifier read one source of truth.
 * All price figures are "credits per kWh" (cc/kWh), matching the on-chain
 * marketplace unit used by the EnergyTrading contract.
 *
 * Security/guardrail posture (2.3):
 *   - FAIL-CLOSED. `AUTO_TRADING_ENABLED` defaults to false. The matcher never
 *     starts, the worker refuses to tick, and policy enablement is rejected
 *     until a deployment explicitly opts in. An admin runtime pause (stored in
 *     the AutoTradingConfig doc) is a second, redeploy-free kill switch.
 *   - v1 is NOTIFY-ONLY. `AUTO_TRADING_AUTO_SUBMIT=false` (hard default). The
 *     backend never holds private keys, never relays transactions, and never
 *     claims a listing succeeded without an on-chain receipt. The user always
 *     confirms the real `listEnergy` tx in MetaMask.
 *   - No private keys on the server. The user signs an EIP-712 *off-chain*
 *     listing intent at policy-enable time; the backend stores only the
 *     signature + bounds + nonce, verifies the signer, and respects the caps.
 *     Intents expire (default 24h) and carry a per-user nonce for replay
 *     protection.
 *   - Hard limits: maxListingsPerDay, maxTotalCcPerDay, minTimeBetweenListings.
 *   - Idempotent jobs keyed per `policyId:hourBucket` via Redis SETNX.
 *   - The smart contract remains the single source of truth for executed
 *     prices and listing state.
 *
 * Conventions:
 *   - Like the rollup / public-grid workers, the matcher uses a plain
 *     `setInterval` loop with Redis idempotency rather than introducing a
 *     BullMQ dependency, matching the rest of the codebase.
 */

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const toFinite = (value, fallback) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Algorithm/policy versioning — bumped when the match decision logic changes.
// Surfaced on every decision so the UI/auditors can correlate inputs/outputs.
const AUTO_TRADING_ALGO_VERSION = '1.0.0';

// Master feature flag. FAIL-CLOSED: nothing runs until this is true.
const isAutoTradingEnvEnabled = () => toBool(process.env.AUTO_TRADING_ENABLED, false);

// v2 path guard. Auto-submit (relayed on-chain tx) is off by default and must
// be turned on explicitly + requires a configured relayer. In v1 this is a
// hard stop: even if an operator flips the env, the service double-checks a
// relayer is configured before allowing it, and notifyOnly policies ignore it.
const isAutoSubmitEnabled = () => toBool(process.env.AUTO_TRADING_AUTO_SUBMIT, false);

// ── Matcher cadence ──────────────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (matches plan)
const MIN_INTERVAL_MS = 60 * 1000; // never tighter than 1/min
const getMatcherIntervalMs = () => {
  const parsed = toPositiveInt(process.env.AUTO_MATCHER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  return Math.max(parsed, MIN_INTERVAL_MS);
};

// ── Idempotency ──────────────────────────────────────────────────────────────
// Job id = `policyId:hourBucket`. The SETNX TTL must outlive one tick so a
// duplicate tick within the same UTC hour is a no-op.
const getIdempotencyTtlSeconds = () => {
  // ~2x the matcher interval, floored to a sane minimum.
  return Math.max(600, Math.ceil((getMatcherIntervalMs() * 2) / 1000));
};

// ── Hard limits (per-policy defaults; each policy may clamp further) ─────────
const DEFAULT_MAX_LISTINGS_PER_DAY = 3;
const getMaxListingsPerDayDefault = () =>
  toPositiveInt(process.env.AUTO_TRADING_MAX_LISTINGS_PER_DAY, DEFAULT_MAX_LISTINGS_PER_DAY);
const ABSOLUTE_MAX_LISTINGS_PER_DAY = 24; // hard ceiling a policy can never exceed

const DEFAULT_MAX_TOTAL_CC_PER_DAY = 1000;
const getMaxTotalCcPerDayDefault = () =>
  toFinite(process.env.AUTO_TRADING_MAX_TOTAL_CC_PER_DAY, DEFAULT_MAX_TOTAL_CC_PER_DAY);

const DEFAULT_MIN_TIME_BETWEEN_MS = 60 * 60 * 1000; // 1 hour
const getMinTimeBetweenListingsMsDefault = () =>
  toPositiveInt(process.env.AUTO_TRADING_MIN_TIME_BETWEEN_MS, DEFAULT_MIN_TIME_BETWEEN_MS);

const DEFAULT_MIN_SURPLUS_KWH = 1;
const getMinSurplusKwhDefault = () =>
  toFinite(process.env.AUTO_TRADING_MIN_SURPLUS_KWH, DEFAULT_MIN_SURPLUS_KWH);

// ── Signed intent (EIP-712) ──────────────────────────────────────────────────
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h (guardrail)
const getIntentTtlMs = () =>
  toPositiveInt(process.env.AUTO_TRADING_INTENT_TTL_MS, DEFAULT_INTENT_TTL_MS);

// Micro-CC scaling for EIP-712 uint256 price fields (cc has decimals, uint has not).
const MICRO_CC_SCALE = 1_000_000n;

// EIP-712 domain. The verifyingContract is the EnergyTrading contract since
// that is what an executed listing would target. The domain name/version bind
// the signature to EcoPulse so it cannot be replayed against another dapp.
const EIP712_DOMAIN_NAME = 'EcoPulse Auto-Trading';
const EIP712_DOMAIN_VERSION = '1';

// Chain id used for server-side signature verification. The signer (frontend)
// uses EXPECTED_CHAIN_ID from blockchain.js; the backend must verify against
// the same chain id. Falls back to a local dev chain id for tests.
const getChainId = () => {
  const parsed = parseInt(process.env.VITE_CHAIN_ID || process.env.CHAIN_ID || '31337', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 31337;
};

const getEnergyTradingAddress = () => {
  const addr = String(
    process.env.ENERGY_TRADING_ADDRESS || process.env.VITE_ENERGY_TRADING_ADDRESS || '',
  ).trim();
  // Must be a structurally-valid address before it is used in the EIP-712
  // domain (ethers throws on a malformed verifyingContract).
  return /^0x[a-fA-F0-9]{40}$/.test(addr) ? addr : ethersZeroAddress();
};

// ethers.ZeroAddress without importing ethers at module top (keeps config
// importable in pure-math test contexts). The intent service re-validates.
function ethersZeroAddress() {
  return '0x0000000000000000000000000000000000000000';
}

// ── Fixed-discount strategy tuning ───────────────────────────────────────────
const DEFAULT_FIXED_DISCOUNT_PERCENT = 5; // 5% below forecast-derived unit price
const getFixedDiscountPercentDefault = () => {
  const v = toFinite(process.env.AUTO_TRADING_FIXED_DISCOUNT_PERCENT, DEFAULT_FIXED_DISCOUNT_PERCENT);
  return Math.min(90, Math.max(0, v));
};

// Redis key prefixes.
const KEYS = {
  JOB: 'auto:job', // idempotency: {policyId}:{hourBucket}
  QUOTA_LISTINGS: 'auto:quota:listings', // {policyId}:{YYYY-MM-DD}
  QUOTA_CC: 'auto:quota:cc', // {policyId}:{YYYY-MM-DD}
  LAST_MATCH: 'auto:lastmatch', // {policyId}
};

/**
 * UTC date bucket string (YYYY-MM-DD) for per-day quota keys.
 */
const dayBucket = (date = new Date()) => {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * UTC hour bucket string (YYYY-MM-DDTHH) for per-hour job idempotency.
 */
const hourBucket = (date = new Date()) => {
  const d = new Date(date);
  const day = dayBucket(d);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${day}T${hh}`;
};

/**
 * Clamp a policy's per-day listing limit to the global absolute ceiling.
 */
const clampMaxListingsPerDay = (value) => {
  const v = parseInt(value, 10);
  if (!Number.isFinite(v) || v < 1) return getMaxListingsPerDayDefault();
  return Math.min(v, ABSOLUTE_MAX_LISTINGS_PER_DAY);
};

/**
 * Clamp a per-day CC budget to a positive number.
 */
const clampMaxTotalCcPerDay = (value) => {
  const v = parseFloat(value);
  if (!Number.isFinite(v) || v <= 0) return getMaxTotalCcPerDayDefault();
  return v;
};

/**
 * Clamp a min-time-between value to at least one matcher interval.
 */
const clampMinTimeBetweenMs = (value) => {
  const v = parseInt(value, 10);
  if (!Number.isFinite(v) || v < 0) return getMinTimeBetweenListingsMsDefault();
  return Math.max(v, getMatcherIntervalMs());
};

module.exports = {
  AUTO_TRADING_ALGO_VERSION,
  isAutoTradingEnvEnabled,
  isAutoSubmitEnabled,
  getMatcherIntervalMs,
  getIdempotencyTtlSeconds,
  getMaxListingsPerDayDefault,
  ABSOLUTE_MAX_LISTINGS_PER_DAY,
  getMaxTotalCcPerDayDefault,
  getMinTimeBetweenListingsMsDefault,
  getMinSurplusKwhDefault,
  getIntentTtlMs,
  MICRO_CC_SCALE,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  getChainId,
  getEnergyTradingAddress,
  getFixedDiscountPercentDefault,
  DEFAULT_FIXED_DISCOUNT_PERCENT,
  KEYS,
  dayBucket,
  hourBucket,
  clampMaxListingsPerDay,
  clampMaxTotalCcPerDay,
  clampMinTimeBetweenMs,
  toBool,
  toFinite,
  toPositiveInt,
};
