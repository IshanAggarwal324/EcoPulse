import React from 'react';
import { useSettlementStatus } from '../../hooks/useSettlementStatus';

/**
 * SettlementStatusTimeline — Module 6.4.4
 *
 * Renders the unified settlement lifecycle for a just-completed purchase:
 * submits the tx for verification and shows the derived timeline until a
 * terminal state (released / mismatch / disputed / refunded) is reached.
 */

const STEP_STYLE = {
  completed: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  active: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
  pending: { dot: 'bg-slate-600', text: 'text-slate-400' },
  failed: { dot: 'bg-rose-500', text: 'text-rose-300' },
};

const CURRENT_BADGE = {
  pending: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  on_chain_confirmed: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  readings_verified: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  released: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  disputed: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  mismatch: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
  refunded: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
};

const CURRENT_LABEL = {
  pending: 'Awaiting on-chain confirmation',
  on_chain_confirmed: 'On-chain confirmed',
  readings_verified: 'Readings verified',
  released: 'Funds released',
  disputed: 'Disputed',
  mismatch: 'Delivery mismatch',
  refunded: 'Refunded',
};

export default function SettlementStatusTimeline({ txHash, listingId, onClose }) {
  const { loading, error, current, timeline, settlement, reset } = useSettlementStatus({
    txHash,
    listingId,
    enabled: true,
  });

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-slate-100">Settlement status</h3>
          {current && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${
                CURRENT_BADGE[current] || CURRENT_BADGE.pending
              }`}
            >
              {CURRENT_LABEL[current] || current}
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xs"
          >
            Close
          </button>
        )}
      </div>

      {txHash && (
        <div className="text-[11px] text-slate-500 font-mono truncate">
          Tx {txHash.slice(0, 10)}…{txHash.slice(-6)}
        </div>
      )}

      {loading && !current && <div className="text-xs text-slate-400">Verifying on-chain receipt…</div>}

      {error && (
        <div className="text-xs text-rose-300">
          Couldn&apos;t verify settlement: {error.message || 'unknown error'}.
          <button type="button" onClick={reset} className="ml-2 underline hover:text-rose-200">
            Retry
          </button>
        </div>
      )}

      {timeline && (
        <ol className="space-y-2">
          {timeline.map((s) => {
            const st = STEP_STYLE[s.status] || STEP_STYLE.pending;
            return (
              <li key={s.key} className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${st.dot}`} />
                <span className={`text-xs ${st.text} ${s.status === 'pending' ? 'opacity-60' : ''}`}>
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {settlement?.mismatchFlags?.length > 0 && (
        <div className="text-[11px] text-orange-300">Flags: {settlement.mismatchFlags.join(', ')}</div>
      )}
    </div>
  );
}
