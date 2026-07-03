import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap, Activity } from 'lucide-react';
import { tradesApi } from '../../utils/api';
import { useSocketEvent } from '../../context/SocketContext';
import { SOCKET_EVENTS } from '../../constants/socketEvents';

/**
 * Module 9.4 — Live trade ticker.
 *
 * Seeds from GET /trades/recent (anonymized global feed), then prepends each
 * inbound `tradeExecuted` socket event. Defensive on every boundary:
 *  - normalizeItem() drops/repairs malformed payloads (never trust the wire)
 *  - hard buffer cap (MAX_ITEMS) prevents unbounded memory growth from a flood
 *  - dedup by stable `id` so a reconnect/replay never doubles a trade
 *  - all values are text-rendered (React escapes) — no innerHTML, no XSS vector
 */
const MAX_ITEMS = 50;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const fmt = (n, d = 2) => num(n).toLocaleString(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: d,
});

const fmtTime = (ts) => {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
};

const normalizeItem = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null;
  if (!id) return null;
  return {
    id,
    listingId: raw.listingId ?? null,
    seller: typeof raw.seller === 'string' && raw.seller ? raw.seller : '0x…',
    buyer: typeof raw.buyer === 'string' && raw.buyer ? raw.buyer : '0x…',
    kwh: num(raw.kwh),
    price: num(raw.price),
    pricePerKwh: num(raw.pricePerKwh),
    ts: typeof raw.ts === 'string' ? raw.ts : new Date().toISOString(),
  };
};

const TickerChip = ({ item }) => (
  <div
    className="shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/40"
    title={`Listing #${item.listingId ?? '—'} · ${item.seller} → ${item.buyer}`}
  >
    <Zap size={14} className="text-amber-400 shrink-0" />
    <span className="text-emerald-300 font-semibold tabular-nums">{fmt(item.kwh)} kWh</span>
    <span className="text-slate-600">@</span>
    <span className="text-slate-300 tabular-nums">{fmt(item.price, 4)} CC</span>
    <span className="text-slate-500 text-xs tabular-nums">({fmt(item.pricePerKwh, 4)}/kWh)</span>
    <span className="text-slate-600">·</span>
    <span className="text-slate-400 text-xs font-mono">{item.seller}</span>
    <span className="text-slate-600">→</span>
    <span className="text-slate-400 text-xs font-mono">{item.buyer}</span>
    <span className="text-slate-600 text-xs tabular-nums">{fmtTime(item.ts)}</span>
  </div>
);

const LiveTradeTicker = () => {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | empty | error
  const idsRef = useRef(new Set());

  useEffect(() => {
    let active = true;
    tradesApi
      .getRecent({ limit: MAX_ITEMS })
      .then((res) => {
        if (!active) return;
        const shaped = Array.isArray(res?.data) ? res.data.map(normalizeItem).filter(Boolean) : [];
        idsRef.current = new Set(shaped.map((i) => i.id));
        setItems(shaped);
        setStatus(shaped.length ? 'ready' : 'empty');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, []);

  const handleTrade = useCallback((raw) => {
    const item = normalizeItem(raw);
    if (!item) return;
    if (idsRef.current.has(item.id)) return;
    idsRef.current.add(item.id);
    setItems((prev) => [item, ...prev].slice(0, MAX_ITEMS));
    setStatus('ready');
  }, []);

  useSocketEvent(SOCKET_EVENTS.SERVER.TRADE_EXECUTED, handleTrade);

  const live = status === 'ready';

  return (
    <section
      aria-label="Live trade ticker"
      className="content-card rounded-xl p-3 sm:p-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`relative flex h-2.5 w-2.5 ${live ? '' : 'opacity-50'}`}
          aria-hidden="true"
        >
          {live && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          )}
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${live ? 'bg-emerald-500' : 'bg-slate-500'}`} />
        </span>
        <Activity size={16} className="text-emerald-400" />
        <h3 className="text-sm font-semibold text-slate-200">Live Trades</h3>
        <span className="ml-auto text-xs text-slate-500 tabular-nums">{items.length}</span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {status === 'loading' && (
          <p className="text-slate-500 text-sm py-2">Loading recent trades…</p>
        )}
        {status === 'error' && (
          <p className="text-rose-400 text-sm py-2">Couldn’t load recent trades.</p>
        )}
        {status !== 'loading' && status !== 'error' && items.length === 0 && (
          <p className="text-slate-500 text-sm py-2">No trades yet — activity will stream in live.</p>
        )}
        {items.map((item) => (
          <TickerChip key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
};

export default LiveTradeTicker;
