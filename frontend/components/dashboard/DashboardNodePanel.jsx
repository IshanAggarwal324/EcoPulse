import React, { memo, lazy, Suspense, useState, useCallback } from 'react';
import { ChevronDown, Loader2, TrendingUp } from 'lucide-react';
import { useNodeForecasts, useNodeForecast, summarizeForecast } from '../../hooks/useNodeForecast';

// Lazy-load recharts only when a node is expanded (keeps the dashboard light).
const ForecastChart = lazy(() => import('../ui/ForecastChart'));

const fmt = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '—');

/** Compact inline SVG sparkline — no chart lib. */
const Sparkline = memo(function Sparkline({ values, color = '#10b981', width = 132, height = 34 }) {
  const pts = Array.isArray(values) ? values.filter((v) => Number.isFinite(Number(v))) : [];
  if (pts.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center text-[10px] text-slate-600">
        —
      </div>
    );
  }
  const nums = pts.map(Number);
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const range = max - min || 1;
  const stepX = width / (nums.length - 1);
  const coords = nums
    .map((v, i) => `${(i * stepX).toFixed(2)},${(height - ((v - min) / range) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');
  const areaCoords = `0,${height} ${coords} ${width},${height}`;
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Forecast trend">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaCoords} fill={`url(#${gid})`} />
      <polyline
        points={coords}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
});

/** Expandable full forecast chart. Hooks-safe (one instance per expanded node). */
const NodeForecastDetail = memo(function NodeForecastDetail({ nodeId, horizon }) {
  const { predictions, loading, error } = useNodeForecast({ nodeId, horizon });

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-slate-400">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">Loading forecast…</span>
      </div>
    );
  }
  if (error) {
    return <p className="text-xs text-rose-300 py-3">Forecast unavailable: {error}</p>;
  }
  return (
    <div className="pt-1">
      <ForecastChart predictions={predictions} compact bandIdPrefix={`dash-${nodeId}`} />
    </div>
  );
});

const NodeRow = memo(function NodeRow({ node, forecast, horizon, expanded, onToggle }) {
  const summary = summarizeForecast(forecast);
  const isGen = node.type !== 'Consumption';
  const sparkColor = isGen ? '#10b981' : '#f43f5e';

  return (
    <div className="glass-card rounded-xl card-hover-glow overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(node.id)}
        aria-expanded={expanded}
        className="w-full text-left p-4 flex items-center gap-3"
      >
        <div className="p-2 bg-slate-800/80 rounded-lg border border-slate-700/30 shrink-0">{node.icon}</div>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-slate-200 truncate">{node.name}</h4>
          <p className="text-[11px] text-slate-500">{node.type}</p>
        </div>
        <div className="hidden sm:block">
          <Sparkline values={summary.generationSeries} color={sparkColor} />
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] text-slate-600 uppercase tracking-wider">Output</p>
          <p className="font-medium text-white text-sm">{node.output}</p>
        </div>
        <span
          className={`text-[11px] px-2.5 py-1 rounded-lg font-medium shrink-0 ${
            node.status === 'Optimal'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-slate-800/60 text-slate-400 border border-slate-700/40'
          }`}
        >
          {node.status}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <div className="px-4 pb-3 -mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {summary.pointCount > 0 ? (
          <>
            <span>
              Avg gen: <span className="text-slate-300 font-mono">{fmt(summary.avgGeneration)} kW</span>
            </span>
            <span>
              Peak: <span className="text-slate-300 font-mono">{fmt(summary.peakGeneration)} kW</span>
            </span>
            <span>
              Confidence:{' '}
              <span className="text-violet-300 font-mono">{fmt(summary.avgConfidence, 0)}%</span>
            </span>
          </>
        ) : (
          <span className="text-slate-600">No forecast for this node</span>
        )}
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-700/40 pt-3">
          <div className="flex items-center gap-1.5 text-slate-300 text-xs font-medium mb-2">
            <TrendingUp size={13} className="text-emerald-400" />
            7-day forecast
          </div>
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-2 py-6 text-slate-400">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-xs">Loading chart…</span>
              </div>
            }
          >
            <NodeForecastDetail nodeId={node.id} horizon={horizon} />
          </Suspense>
        </div>
      )}
    </div>
  );
});

const DashboardNodePanel = memo(function DashboardNodePanel({ nodeStatus, horizon = 7 }) {
  const { byNodeId, loading, error } = useNodeForecasts({
    horizon,
    enabled: nodeStatus.length > 0,
  });
  const [expandedId, setExpandedId] = useState(null);

  const handleToggle = useCallback((id) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  return (
    <div className="glass-card rounded-2xl p-5 sm:p-6 glow-emerald card-hover-glow">
      <div className="flex items-center gap-2 mb-5">
        <h3 className="text-lg sm:text-xl font-bold text-white">Node Status</h3>
        <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-700/40 text-slate-400 border border-slate-700/30">
          {nodeStatus.length} nodes
        </span>
        {loading && <Loader2 size={13} className="animate-spin text-slate-500 ml-1" />}
      </div>

      {nodeStatus.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-slate-500 text-sm">No nodes registered</p>
          <p className="text-slate-600 text-xs mt-1">Create nodes via the API or simulator</p>
        </div>
      ) : error ? (
        <p className="text-xs text-amber-300 py-4">Forecasts unavailable: {error}</p>
      ) : (
        <div className="space-y-3">
          {nodeStatus.map((node) => (
            <NodeRow
              key={node.id || node.name}
              node={node}
              forecast={node.id ? byNodeId[node.id] : undefined}
              horizon={horizon}
              expanded={expandedId === node.id}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default DashboardNodePanel;
