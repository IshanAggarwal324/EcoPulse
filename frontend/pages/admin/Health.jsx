import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity,
  RefreshCw,
  Database,
  BrainCircuit,
  Sparkles,
  Boxes,
  Server,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Timer,
  Gauge,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import PageLoader from '../../components/ui/PageLoader';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { timeAgo, formatDateTime } from '../../utils/adminFormat';

const POLL_MS = 30000;

const STATUS_TONE = {
  up: {
    pill: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    icon: 'bg-emerald-500/10 text-emerald-400',
    dot: 'bg-emerald-400',
    label: 'Operational',
  },
  degraded: {
    pill: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
    icon: 'bg-amber-500/10 text-amber-400',
    dot: 'bg-amber-400',
    label: 'Degraded',
  },
  down: {
    pill: 'bg-rose-500/10 border-rose-500/30 text-rose-400',
    icon: 'bg-rose-500/10 text-rose-400',
    dot: 'bg-rose-400',
    label: 'Down',
  },
};

const OVERALL_TONE = {
  healthy: {
    cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    label: 'All systems operational',
    Icon: CheckCircle2,
  },
  degraded: {
    cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    label: 'Degraded performance',
    Icon: AlertTriangle,
  },
  down: {
    cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    label: 'Critical outage',
    Icon: XCircle,
  },
};

const COMPONENTS = [
  { key: 'mongodb', label: 'MongoDB', icon: Database },
  { key: 'aiService', label: 'AI Service', icon: BrainCircuit },
  { key: 'genaiService', label: 'GenAI Service', icon: Sparkles },
  { key: 'blockchain', label: 'Blockchain', icon: Boxes },
  { key: 'backend', label: 'Backend', icon: Server },
  { key: 'simulator', label: 'Simulator', icon: Gauge },
];

const tone = (status) => STATUS_TONE[status] || STATUS_TONE.down;

const latencyLabel = (ms) => (ms != null && ms > 0 ? `${Math.round(ms)}ms` : null);

const componentSub = (key, probe) => {
  const d = probe?.details || {};
  if (key === 'mongodb') {
    return [d.host, d.name].filter(Boolean).join(' · ') || 'Connected';
  }
  if (key === 'aiService' || key === 'genaiService') {
    const bits = [d.url, d.model_loaded != null ? `model: ${d.model_loaded}` : null, d.gemini_status ? `gemini: ${d.gemini_status}` : null];
    return bits.filter(Boolean).join(' · ') || 'Reachable';
  }
  if (key === 'blockchain') {
    return [d.chainName, d.syncLagBlocks != null ? `${d.syncLagBlocks} blocks behind` : null]
      .filter(Boolean)
      .join(' · ') || (probe?.status === 'down' ? 'Unreachable' : 'Synced');
  }
  if (key === 'backend') {
    return d.uptimeLabel ? `Uptime ${d.uptimeLabel}` : 'Running';
  }
  if (key === 'simulator') {
    if (!d.embedded) return 'CLI mode (not embedded)';
    if (!d.enabled) return 'Disabled by config';
    if (d.running) {
      return `${d.nodes ?? 0} nodes · ${d.ticks ?? 0} ticks`;
    }
    return 'Not running';
  }
  return '—';
};

const Health = () => {
  const toast = useToast();

  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const mounted = useRef(true);

  const loadHealth = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await adminApi.getSystemHealth();
      if (!mounted.current) return;
      setHealth(res.data);
      setLastUpdated(new Date());
    } catch (err) {
      if (!mounted.current) return;
      setHealth({ overall: 'down', error: err.message });
      toast.error(err.message || 'Failed to load system health');
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  useEffect(() => {
    mounted.current = true;
    loadHealth();
    return () => {
      mounted.current = false;
    };
  }, [loadHealth]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(loadHealth, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, loadHealth]);

  if (loading && !health) {
    return (
      <div className="page-section w-full">
        <SectionTitle title="System Health" subtitle="Unified service probes" />
        <PageLoader message="Probing services…" />
      </div>
    );
  }

  const overall = health?.overall || 'down';
  const overallCfg = OVERALL_TONE[overall] || OVERALL_TONE.down;
  const components = health?.components || {};
  const blockchain = components.blockchain?.details || {};
  const backend = components.backend?.details || {};
  const lastSync = blockchain.lastSync || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="System Health"
        subtitle="Unified probes for MongoDB, AI, GenAI, blockchain sync, and backend"
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                autoRefresh
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-slate-800/60 text-slate-400 border-slate-700/40 hover:text-slate-200'
              }`}
              title="Toggle auto-refresh"
            >
              <Activity size={14} />
              {autoRefresh ? 'Live' : 'Paused'}
            </button>
            <button
              type="button"
              onClick={loadHealth}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Overall status banner */}
      <div className={`flex items-center gap-3 p-4 rounded-2xl border mb-6 ${overallCfg.cls}`}>
        <overallCfg.Icon size={22} className="flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-bold">{overallCfg.label}</p>
          <p className="text-xs opacity-80 truncate">
            {health?.error
              ? health.error
              : `Checked ${health?.checkedAt ? formatDateTime(health.checkedAt) : '—'}`}
          </p>
        </div>
      </div>

      {/* Component grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {COMPONENTS.map(({ key, label, icon: Icon }) => {
          const probe = components[key] || { status: 'down' };
          const t = tone(probe.status);
          const lat = latencyLabel(probe.latencyMs);
          const sub = componentSub(key, probe);
          return (
            <div key={key} className="content-card">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`p-2 rounded-lg flex-shrink-0 ${t.icon}`}>
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{label}</p>
                    <p className="text-[11px] text-slate-500 truncate">{sub}</p>
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border flex-shrink-0 ${t.pill}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
                  {t.label}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                {lat ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                    <Timer size={12} /> {lat}
                  </span>
                ) : (
                  <span />
                )}
                {probe.error && (
                  <span className="text-[11px] text-rose-400/90 truncate text-right" title={probe.error}>
                    {probe.error}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Blockchain detail */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="content-card">
          <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <Boxes size={16} className="text-emerald-400" /> Blockchain sync
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            <DetailRow label="Chain" value={blockchain.chainName || '—'} />
            <DetailRow label="Chain ID" value={blockchain.chainId != null ? String(blockchain.chainId) : '—'} />
            <DetailRow label="Head block" value={blockchain.blockNumber?.toLocaleString() ?? '—'} />
            <DetailRow label="Last synced" value={blockchain.lastSyncedBlock?.toLocaleString() ?? '—'} />
            <DetailRow
              label="Sync lag"
              value={blockchain.syncLagBlocks != null ? `${blockchain.syncLagBlocks.toLocaleString()} blocks` : '—'}
              tone={blockchain.syncLagBlocks > 50 ? 'warn' : 'default'}
            />
            <DetailRow label="Trades indexed" value={blockchain.tradeCount?.toLocaleString() ?? '—'} />
            <DetailRow label="RPC host" value={blockchain.rpcHost || '—'} />
            <DetailRow label="Last sync run" value={lastSync.at ? timeAgo(lastSync.at) : 'Never'} />
          </dl>
        </div>

        {/* Backend detail */}
        <div className="content-card">
          <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <Server size={16} className="text-emerald-400" /> Backend process
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            <DetailRow label="Uptime" value={backend.uptimeLabel || '—'} />
            <DetailRow label="Node version" value={backend.nodeVersion || '—'} />
            <DetailRow
              label="RSS memory"
              value={backend.memory ? `${backend.memory.rssMb} MB` : '—'}
            />
            <DetailRow
              label="Heap used"
              value={backend.memory ? `${backend.memory.heapUsedMb} / ${backend.memory.heapTotalMb} MB` : '—'}
            />
            <DetailRow label="Platform" value={backend.platform || '—'} />
            <DetailRow label="PID" value={backend.pid != null ? String(backend.pid) : '—'} />
            <DetailRow
              label="External mem"
              value={backend.memory ? `${backend.memory.externalMb} MB` : '—'}
            />
            <DetailRow label="Last checked" value={components.backend?.checkedAt ? timeAgo(components.backend.checkedAt) : '—'} />
          </dl>
        </div>
      </div>

      {/* Legend + last updated */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6">
        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Operational</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Degraded</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> Down</span>
        </div>
        {lastUpdated && (
          <p className="text-xs text-slate-600">
            Last updated {timeAgo(lastUpdated)}{autoRefresh ? ' · auto-refreshing every 30s' : ''}
          </p>
        )}
      </div>
    </div>
  );
};

const DetailRow = ({ label, value, tone: rowTone = 'default' }) => (
  <div className="flex items-center justify-between gap-4 py-1.5 border-b border-slate-800/50 last:border-0">
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd
      className={`text-sm font-medium text-right truncate max-w-[60%] ${
        rowTone === 'warn' ? 'text-amber-400' : 'text-slate-200'
      }`}
      title={value}
    >
      {value}
    </dd>
  </div>
);

export default Health;
