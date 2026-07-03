/**
 * Settlement socket helpers — Module 9.6.
 *
 * Pure, dependency-free validation/matching for the `settlementVerified` and
 * `settlementMismatch` socket events. Kept side-effect free (no React, no api)
 * so it is unit-testable under node --test, and so the security boundary
 * ("never trust the wire") lives in one audited place.
 */

export const TX_HASH_RE = /^0x[a-f0-9]{64}$/i;

const TERMINAL_FROM_EVENT = new Set(['verified', 'mismatch', 'disputed']);

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalize an inbound settlement socket payload into a trusted shape, or
 * return null if it is malformed / unidentifiable. Drops unknown keys so a
 * malicious or buggy emitter cannot inject arbitrary data into client state.
 *
 * @param {unknown} raw
 * @returns {{
 *   settlementId: string|null,
 *   txHash: string|null,
 *   listingId: number|null,
 *   verificationStatus: string|null,
 *   deltaPct: number|null,
 *   mismatchFlags: string[],
 *   at: string,
 * } | null}
 */
export function normalizeSettlementEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const txHash =
    typeof raw.txHash === 'string' && TX_HASH_RE.test(raw.txHash)
      ? raw.txHash.toLowerCase()
      : null;

  const settlementId =
    typeof raw.settlementId === 'string' && raw.settlementId.trim()
      ? raw.settlementId.trim().slice(0, 64)
      : null;

  // Need at least one stable identifier to act on the event.
  if (!txHash && !settlementId) return null;

  const listingId = numOrNull(raw.listingId);

  const mismatchFlags = Array.isArray(raw.mismatchFlags)
    ? raw.mismatchFlags
        .filter((f) => typeof f === 'string' && /^[A-Z0-9_]{1,40}$/.test(f))
        .slice(0, 8)
    : [];

  return {
    settlementId,
    txHash,
    listingId: Number.isFinite(listingId) ? listingId : null,
    verificationStatus:
      typeof raw.verificationStatus === 'string' &&
      ['pending', 'verified', 'mismatch', 'disputed'].includes(raw.verificationStatus)
        ? raw.verificationStatus
        : null,
    deltaPct: numOrNull(raw.deltaPct),
    mismatchFlags,
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  };
}

/**
 * Does this event refer to the settlement we are currently tracking? Matches
 * strictly on txHash (case-insensitive, canonical chain format). Returns false
 * for any invalid input — including a txHash-less event — so a garbage or
 * non-matching payload can never trigger a state mutation. We intentionally do
 * NOT fall back to settlementId matching: an id-only event can't be safely
 * attributed to one specific trade, which would let it cross-talk between
 * concurrent settlement trackers. The backend always emits a txHash, so this is
 * safe and stricter.
 *
 * @param {string|null|undefined} trackedTxHash
 * @param {unknown} event
 * @returns {boolean}
 */
export function matchesSettlementEvent(trackedTxHash, event) {
  if (!trackedTxHash || !TX_HASH_RE.test(trackedTxHash)) return false;
  const evt = normalizeSettlementEvent(event);
  if (!evt || !evt.txHash) return false;
  return evt.txHash === trackedTxHash.toLowerCase();
}

/**
 * Whether a normalized event describes a terminal state, so a consumer can stop
 * polling immediately instead of waiting for the next scheduled tick.
 */
export function isTerminalSettlementEvent(event) {
  const evt = normalizeSettlementEvent(event);
  if (!evt || !evt.verificationStatus) return false;
  return TERMINAL_FROM_EVENT.has(evt.verificationStatus);
}
