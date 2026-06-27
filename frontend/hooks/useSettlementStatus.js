import { useEffect, useRef, useState, useCallback } from 'react';
import { settlementsApi } from '../utils/api';

/**
 * useSettlementStatus — Module 6.4.4
 *
 * After a marketplace purchase, submit the tx for on-chain receipt verification
 * (`POST /settlements/verify`) once, then poll the lifecycle-enriched settlement
 * (`GET /marketplace/settlements/:tradeId`) until it reaches a terminal state.
 *
 * Guardrails (client side):
 *  - txHash is validated (0x + 64 hex) before any request is made.
 *  - Polling is BOUNDED (MAX_ATTEMPTS) so a stuck reconciliation can never spin
 *    forever and rack up requests/cost.
 *  - Backoff grows up to a cap; polling pauses while the tab is hidden.
 *  - All timers are cleared on unmount / dependency change (no leaked loops).
 */

const TERMINAL = new Set(['released', 'mismatch', 'disputed', 'refunded']);
const TX_HASH_RE = /^0x[a-f0-9]{64}$/i;
const MAX_ATTEMPTS = 40;
const MAX_DELAY_MS = 8000;
const BASE_DELAY_MS = 2000;

const backoff = (attempt) =>
  Math.min(BASE_DELAY_MS * Math.pow(1.4, Math.min(attempt, 6)), MAX_DELAY_MS);

export function useSettlementStatus({ txHash, listingId, enabled = true }) {
  const [state, setState] = useState({
    loading: false,
    settlement: null,
    timeline: null,
    current: null,
    error: null,
  });
  const timerRef = useRef(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setState({ loading: false, settlement: null, timeline: null, current: null, error: null });
  }, [stop]);

  useEffect(() => {
    if (!enabled || !txHash || !TX_HASH_RE.test(txHash)) return undefined;

    let cancelled = false;

    const poll = async (id, attempt) => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timerRef.current = setTimeout(() => poll(id, attempt), 1500);
        return;
      }
      try {
        const data = await settlementsApi.getMyByTradeId(id);
        if (cancelled) return;
        const current = data?.lifecycle?.current;
        setState({
          loading: false,
          settlement: data,
          timeline: data?.lifecycle?.steps || null,
          current,
          error: null,
        });
        if (TERMINAL.has(current)) return;
        if (attempt >= MAX_ATTEMPTS) return;
        timerRef.current = setTimeout(() => poll(id, attempt + 1), backoff(attempt));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, error: err }));
      }
    };

    const run = async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await settlementsApi.verify(txHash, listingId);
        if (cancelled) return;
        const id = res?.settlement?._id;
        if (!id) {
          setState((s) => ({ ...s, loading: false, error: new Error('No settlement id returned') }));
          return;
        }
        poll(id, 0);
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, error: err }));
      }
    };

    run();
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, txHash, listingId, stop]);

  return { ...state, reset };
}

export default useSettlementStatus;
