import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyticsApi } from '../../utils/api';
import { useSocketEvent } from '../../context/SocketContext';
import { SOCKET_EVENTS } from '../../constants/socketEvents';
import { Loader2, AlertTriangle, Activity } from 'lucide-react';

/**
 * Energy / carbon flow Sankey — Module 9.1.
 *
 * Self-contained card: fetches `/analytics/energy-flow`, owns the time-window
 * toggle, and re-fetches on blockchain events (`refreshKey`/socket). Renders a
 * dependency-free SVG Sankey (wallet → wallet flows) so no new chart lib is
 * bundled. Left column = net exporters (producers), middle = hubs, right = net
 * importers (consumers); kWh links are emerald, carbon-credit links are sky.
 */

const WINDOWS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const NODE_COLORS = {
  producer: '#34d399', // emerald-400
  consumer: '#fbbf24', // amber-400
  prosumer: '#a78bfa', // violet-400
};
const LINK_COLORS = { kWh: '#34d399', CC: '#38bdf8' };

const shortAddr = (a) => {
  const s = String(a || '');
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

const fmt = (n, digits = 2) =>
  Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }) : '0';

/**
 * Pure layout: map abstract nodes/links to SVG geometry. Exported for tests.
 */
export function layoutSankey(nodes, links, geom = {}) {
  const W = geom.width || 960;
  const H = geom.height || 460;
  const padX = geom.padX || 90;
  const padY = geom.padY || 24;
  const barW = geom.barWidth || 14;
  const gap = geom.gap || 10;
  const minBar = geom.minBar || 8;
  const maxThickness = geom.maxThickness || 26;

  const layerX = { 0: padX, 1: W / 2, 2: W - padX };
  const availH = H - padY * 2;

  const byLayer = { 0: [], 1: [], 2: [] };
  for (const n of nodes) {
    const layer = [0, 1, 2].includes(n.layer) ? n.layer : 1;
    byLayer[layer].push(n);
  }

  const totalOf = (n) => (Number(n.outValue) || 0) + (Number(n.inValue) || 0);
  const grandMax = Math.max(1, ...nodes.map(totalOf));

  // Position each node bar within its layer column.
  const pos = new Map();
  for (const layer of [0, 1, 2]) {
    const items = byLayer[layer].sort((a, b) => totalOf(b) - totalOf(a));
    const rawHeights = items.map((n) => Math.max(minBar, (totalOf(n) / grandMax) * availH));
    const sumRaw = rawHeights.reduce((s, h) => s + h, 0) + Math.max(0, items.length - 1) * gap;
    const scale = sumRaw > availH ? availH / sumRaw : 1;
    let y = padY;
    items.forEach((n, i) => {
      const h = Math.max(minBar, rawHeights[i] * scale);
      pos.set(n.id, { x: layerX[layer] - barW / 2, y0: y, y1: y + h, height: h });
      y += h + gap;
    });
  }

  // Max link value → stroke thickness scale.
  const maxLink = Math.max(1, ...links.map((l) => Number(l.value) || 0));

  // Cursors per node for stacking outgoing/incoming endpoints.
  const outCursor = new Map();
  const inCursor = new Map();
  for (const id of pos.keys()) {
    outCursor.set(id, 0);
    inCursor.set(id, 0);
  }

  const positionedLinks = links
    .map((l) => {
      const s = pos.get(l.source);
      const t = pos.get(l.target);
      if (!s || !t) return null;
      const thickness = Math.max(0.8, ((Number(l.value) || 0) / maxLink) * maxThickness);

      const sy = s.y0 + outCursor.get(l.source) + thickness / 2;
      outCursor.set(l.source, outCursor.get(l.source) + thickness);

      const ty = t.y0 + inCursor.get(l.target) + thickness / 2;
      inCursor.set(l.target, inCursor.get(l.target) + thickness);

      const sx = s.x + barW;
      const tx = t.x;
      const cx = sx + (tx - sx) / 2;
      const d = `M ${sx},${sy} C ${cx},${sy} ${cx},${ty} ${tx},${ty}`;
      return { ...l, d, thickness, color: LINK_COLORS[l.unit] || '#64748b' };
    })
    .filter(Boolean);

  const positionedNodes = nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return null;
      return { ...n, ...p };
    })
    .filter(Boolean);

  return { nodes: positionedNodes, links: positionedLinks, width: W, height: H, barW };
}

const FlowTooltip = ({ children }) => <title>{children}</title>;

const LegendDot = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
    {label}
  </span>
);

const EnergyFlowSankey = ({ refreshKey = 0 }) => {
  const [windowSel, setWindowSel] = useState('7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (w) => {
    setLoading(true);
    setError(null);
    try {
      const res = await analyticsApi.getEnergyFlow(w);
      setData(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Failed to load energy flow');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(windowSel);
  }, [windowSel, load, refreshKey]);

  // Module 9.6 — refresh on live trade activity. A purchase fires both
  // `tradeExecuted` and `blockchainEvent`, so debounce (rather than bind two
  // eager fetches) to coalesce a burst into a single analytics request. This
  // also caps the request rate if a sync pass emits a flood of events.
  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      load(windowSel);
    }, 700);
  }, [load, windowSel]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useSocketEvent(SOCKET_EVENTS.SERVER.BLOCKCHAIN_EVENT, scheduleRefresh);
  useSocketEvent(SOCKET_EVENTS.SERVER.TRADE_EXECUTED, scheduleRefresh);

  const layout = useMemo(() => {
    if (!data?.nodes?.length || !data?.links?.length) return null;
    return layoutSankey(data.nodes, data.links);
  }, [data]);

  const summary = data?.summary || {};
  const hasData = !!layout && layout.links.length > 0;

  return (
    <div className="content-card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
            <Activity size={18} className="text-emerald-400" />
            Energy flow
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Who exported and imported energy and carbon credits between wallets.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-600/60 overflow-hidden self-start">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => setWindowSel(w.value)}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                windowSel === w.value
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Energy traded" value={`${fmt(summary.totalEnergyKwh)} kWh`} accent="text-emerald-300" />
          <Stat
            label="Verified"
            value={`${fmt(summary.verifiedEnergyKwh)} kWh`}
            accent="text-teal-300"
            hint={summary.totalEnergyKwh > 0 ? `${Math.round((summary.verifiedEnergyKwh / summary.totalEnergyKwh) * 100)}% of traded` : null}
          />
          <Stat label="Carbon moved" value={`${fmt(summary.totalCarbonCc)} CC`} accent="text-sky-300" />
          <Stat
            label={data.scope === 'wallet' ? 'Your net generation' : 'Wallets'}
            value={
              data.scope === 'wallet'
                ? `${fmt(summary.netGenerationKwh)} kWh`
                : `${summary.nodeCount || 0}`
            }
            accent="text-violet-300"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
        <LegendDot color={LINK_COLORS.kWh} label="Energy (kWh)" />
        <LegendDot color={LINK_COLORS.CC} label="Carbon credits (CC)" />
        <LegendDot color={NODE_COLORS.producer} label="Producer" />
        <LegendDot color={NODE_COLORS.consumer} label="Consumer" />
        <LegendDot color={NODE_COLORS.prosumer} label="Prosumer" />
      </div>

      {loading && !data ? (
        <div className="flex flex-col items-center justify-center py-14 text-slate-400 gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-emerald-500" />
          <p className="text-sm">Loading energy flow…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
          <AlertTriangle className="h-7 w-7 text-amber-400" />
          <p className="text-sm">{error}</p>
          <button
            type="button"
            onClick={() => load(windowSel)}
            className="touch-target text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-700/60 text-slate-200 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      ) : hasData ? (
        <div className="w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="w-full h-auto"
            style={{ minWidth: 520, maxHeight: 460 }}
            role="img"
            aria-label="Energy and carbon flow diagram"
          >
            {layout.links.map((l, i) => (
              <path
                key={`${l.source}-${l.target}-${l.unit}-${i}`}
                d={l.d}
                fill="none"
                stroke={l.color}
                strokeWidth={l.thickness}
                strokeOpacity={0.32}
              >
                <FlowTooltip>
                  {`${shortAddr(l.source)} → ${shortAddr(l.target)}: ${fmt(l.value, 2)} ${l.unit} (${l.trades || 0} trade${(l.trades || 0) === 1 ? '' : 's'})`}
                </FlowTooltip>
              </path>
            ))}
            {layout.nodes.map((n) => (
              <g key={n.id}>
                <rect
                  x={n.x}
                  y={n.y0}
                  width={layout.barW}
                  height={Math.max(2, n.height)}
                  rx={3}
                  fill={NODE_COLORS[n.type] || '#64748b'}
                >
                  <FlowTooltip>
                    {`${n.name} (${n.type}) · out ${fmt(n.outValue)} · in ${fmt(n.inValue)}`}
                  </FlowTooltip>
                </rect>
                <text
                  x={n.layer === 2 ? n.x - 8 : n.x + layout.barW + 8}
                  y={(n.y0 + n.y1) / 2 + 3}
                  textAnchor={n.layer === 2 ? 'end' : 'start'}
                  className="fill-slate-400"
                  style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}
                >
                  {n.name}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
          <Activity size={26} className="text-slate-600" />
          <p className="text-sm">
            {data?.scope === 'wallet'
              ? 'No trades in this window yet. List or buy energy to see your flow.'
              : 'No marketplace trades in this window.'}
          </p>
        </div>
      )}
    </div>
  );
};

const Stat = ({ label, value, accent, hint }) => (
  <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2">
    <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
    <p className={`text-base font-semibold ${accent}`}>{value}</p>
    {hint && <p className="text-[10px] text-slate-500 mt-0.5">{hint}</p>}
  </div>
);

export default EnergyFlowSankey;
