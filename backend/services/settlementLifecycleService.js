/**
 * Settlement lifecycle — Module 6.4.2
 *
 * The raw model has THREE independent pieces of state, each owned by a
 * different writer:
 *   - Settlement.onChainStatus   (receipt verification: 5.2)
 *   - Settlement.verificationStatus (reconciliation: 5.2)
 *   - Escrow.state               (escrow contract events: 5.1)
 *
 * For a user-facing timeline we collapse those into a single ordered lifecycle
 * (`pending → on_chain_confirmed → readings_verified → released`, with terminal
 * branches `mismatch | disputed | refunded`). The mapping is a PURE, deterministic
 * function of the two docs — no IO, no side effects — so it is trivially unit
 * testable and safe to run on every read.
 *
 * Precedence is deliberately terminal-first so a release can never mask a
 * dispute/refund, and a verified reading can never mask an escrow refund.
 */

const LIFECYCLE_STATUSES = [
  'pending',
  'on_chain_confirmed',
  'readings_verified',
  'released',
  'disputed',
  'refunded',
  'mismatch',
];

// Position on the happy-path timeline. Terminal branches share the final slot
// so they render as a single "resolution" step in the UI.
const LIFECYCLE_ORDER = {
  pending: 0,
  on_chain_confirmed: 1,
  readings_verified: 2,
  released: 3,
  mismatch: 3,
  disputed: 3,
  refunded: 3,
};

const isOnChainConfirmed = (doc) => {
  if (!doc) return false;
  if (doc.onChainStatus && String(doc.onChainStatus).toLowerCase() === 'confirmed') return true;
  const c = Number(doc.confirmations);
  return Number.isFinite(c) && c > 0;
};

const escrowState = (escrow) => (escrow && escrow.state ? String(escrow.state) : null);

/**
 * Derive the current lifecycle status. Pure function.
 * @param {object} doc   a Settlement lean/plain doc
 * @param {object|null} escrow an Escrow lean/plain doc (or null)
 * @returns {string} one of LIFECYCLE_STATUSES
 */
const computeLifecycle = (doc, escrow) => {
  if (!doc) return 'pending';
  const esc = escrowState(escrow);

  // An open dispute is the most serious state and must never be masked by a
  // downstream release/refund (a refund may even be the dispute's resolution).
  if (esc === 'disputed' || doc.verificationStatus === 'disputed') return 'disputed';
  if (esc === 'refunded') return 'refunded';
  if (esc === 'released') return 'released';
  if (doc.verificationStatus === 'mismatch') return 'mismatch';
  if (doc.verificationStatus === 'verified') return 'readings_verified';
  if (isOnChainConfirmed(doc)) return 'on_chain_confirmed';
  return 'pending';
};

const TIMELINE_STEPS = [
  { key: 'created', label: 'Settlement created', lifecycle: 'pending' },
  { key: 'on_chain', label: 'On-chain confirmed', lifecycle: 'on_chain_confirmed' },
  { key: 'readings', label: 'Readings verified', lifecycle: 'readings_verified' },
  { key: 'released', label: 'Funds released', lifecycle: 'released' },
];

const RESOLUTION_LABEL = {
  mismatch: 'Delivery mismatch flagged',
  disputed: 'Dispute opened',
  refunded: 'Funds refunded',
};

const isTerminal = (status) => ['released', 'mismatch', 'disputed', 'refunded'].includes(status);

/**
 * Build an ordered, renderable timeline for a settlement. Pure function.
 * Each step has status: completed | active | pending | failed.
 */
const buildTimeline = (doc, escrow) => {
  const current = computeLifecycle(doc, escrow);
  const curOrder = LIFECYCLE_ORDER[current];

  const steps = TIMELINE_STEPS.map((s) => {
    const ord = LIFECYCLE_ORDER[s.lifecycle];
    let status;
    if (curOrder > ord) status = 'completed';
    else if (curOrder === ord) status = 'active';
    else status = 'pending';
    return { ...s, status };
  });

  // Terminal-but-not-released: the "released" step did not happen; mark it
  // failed and surface an explicit resolution step.
  if (isTerminal(current) && current !== 'released') {
    const releaseStep = steps.find((s) => s.key === 'released');
    if (releaseStep) releaseStep.status = 'failed';
    steps.push({
      key: 'resolution',
      label: RESOLUTION_LABEL[current] || 'Resolved',
      lifecycle: current,
      status: 'active',
    });
  }

  return { current, steps };
};

module.exports = {
  LIFECYCLE_STATUSES,
  LIFECYCLE_ORDER,
  computeLifecycle,
  buildTimeline,
  isOnChainConfirmed,
  isTerminal,
};
