import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database,
  Cpu,
  Globe,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Lock,
  Upload,
  Activity,
  ShieldAlert,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import PageLoader from '../../components/ui/PageLoader';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';
import { timeAgo } from '../../utils/adminFormat';

const POLL_MS = 10000;
const inputClass =
  'w-full px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5';

const MODE_BADGE = {
  simulated: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  device: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  public_api: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  hybrid: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30',
};

const Ingestion = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const mounted = useRef(true);

  // Backfill form state
  const [bfFormat, setBfFormat] = useState('json');
  const [bfSource, setBfSource] = useState('public_api');
  const [bfDryRun, setBfDryRun] = useState(true);
  const [bfConfirmSim, setBfConfirmSim] = useState(false);
  const [bfText, setBfText] = useState('');
  const [bfBusy, setBfBusy] = useState(false);
  const [bfResult, setBfResult] = useState(null);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await adminApi.getIngestionDashboard();
      if (!mounted.current) return;
      setData(res.data);
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err.message || 'Failed to load ingestion dashboard');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    mounted.current = true;
    loadDashboard();
    return () => {
      mounted.current = false;
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(loadDashboard, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, loadDashboard]);

  const handleBackfill = async () => {
    if (!mutate) return;
    const trimmed = bfText.trim();
    if (!trimmed) {
      toast.error('Paste a JSON array/object or CSV to import');
      return;
    }
    setBfBusy(true);
    setBfResult(null);
    try {
      let body;
      if (bfFormat === 'csv') {
        body = { csv: trimmed, defaultSource: bfSource, dryRun: bfDryRun, confirmSimulated: bfConfirmSim };
      } else {
        const parsed = JSON.parse(trimmed);
        body = {
          readings: Array.isArray(parsed) ? parsed : parsed.readings,
          defaultSource: bfSource,
          dryRun: bfDryRun,
          confirmSimulated: bfConfirmSim,
        };
      }
      const res = await adminApi.backfillIngestion(body);
      if (!mounted.current) return;
      setBfResult(res.data);
      if (res.data?.dryRun) {
        toast.success(`Dry run: ${res.data.accepted} would import, ${res.data.rejected} rejected`);
      } else {
        toast.success(`Imported ${res.data.accepted} readings (${res.data.rejected} rejected)`);
        loadDashboard();
      }
    } catch (err) {
      toast.error(err.message || 'Backfill failed');
    } finally {
      if (mounted.current) setBfBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="page-section w-full">
        <SectionTitle title="Ingestion" subtitle="Unified energy-data sources" />
        <PageLoader message="Loading ingestion status…" />
      </div>
    );
  }

  const mode = data?.mode;
  const sim = data?.simulator;
  const devices = data?.devices;
  const publicApi = data?.publicApi;
  const metrics = data?.metrics;

  const lockedDown = mode?.lockdowns?.simulatorLockedDown;

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Ingestion"
        subtitle="Simulator, device telemetry, and public grid pollers"
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
              onClick={loadDashboard}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Mode banner */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border mb-6 ${
          lockedDown
            ? 'bg-rose-500/10 border-rose-500/30'
            : 'bg-slate-800/40 border-slate-700/40'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {lockedDown ? (
            <Lock size={20} className="flex-shrink-0 text-rose-400" />
          ) : (
            <Database size={20} className="flex-shrink-0 text-emerald-400" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-bold text-white">
                Mode: <span className={`px-2 py-0.5 rounded-md text-xs border ${MODE_BADGE[mode?.mode] || MODE_BADGE.simulated}`}>{mode?.mode}</span>
              </p>
              <span className="text-xs text-slate-400">
                {mode?.environment} · {mode?.explicit ? 'env override' : 'default'}
              </span>
            </div>
            <p className="text-xs opacity-80 mt-0.5">
              {lockedDown
                ? 'Simulator locked down in production — demo/seed data disabled.'
                : 'Capabilities: ' +
                  [
                    mode?.capabilities?.simulator && 'simulator',
                    mode?.capabilities?.device && 'device',
                    mode?.capabilities?.publicApi && 'public API',
                  ]
                    .filter(Boolean)
                    .join(', ') || 'none'}
            </p>
          </div>
        </div>
        {!mode?.valid && (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
            <AlertTriangle size={14} /> INGESTION_MODE invalid — using default
          </span>
        )}
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Accepted" value={(metrics?.counters?.accepted ?? 0).toLocaleString()} tone="good" />
        <StatCard label="Rejected" value={(metrics?.counters?.rejected ?? 0).toLocaleString()} tone={metrics?.counters?.rejected ? 'bad' : 'default'} />
        <StatCard label="Duplicates" value={(metrics?.counters?.duplicate ?? 0).toLocaleString()} />
        <StatCard label="Devices seen" value={devices ? (devices.total ?? 0) : '—'} />
        <StatCard label="Public API sources" value={publicApi?.available ? publicApi.enabled ?? 0 : 'n/a'} />
        <StatCard label="Simulator" value={sim?.running ? 'Running' : 'Idle'} tone={sim?.running ? 'good' : 'default'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Simulator section */}
        <SourceCard
          title="Simulator"
          icon={Cpu}
          tone="emerald"
          available={mode?.capabilities?.simulator}
          locked={lockedDown}
        >
          <Row label="Embedded" value={sim?.embedded ? 'Yes' : 'No'} />
          <Row label="Running" value={sim?.running ? 'Yes' : 'No'} />
          <Row label="Nodes" value={sim?.nodes ?? '—'} />
          <Row label="Ticks" value={(sim?.ticks ?? 0).toLocaleString()} />
          <Row label="Readings emitted" value={(sim?.readingsEmitted ?? 0).toLocaleString()} />
          <Row label="Started" value={sim?.startedAt ? timeAgo(sim.startedAt) : '—'} />
          {lockedDown && (
            <p className="text-xs text-rose-400 mt-2 flex items-center gap-1.5">
              <Lock size={12} /> Locked down by INGESTION_MODE
            </p>
          )}
        </SourceCard>

        {/* Device telemetry section */}
        <SourceCard
          title="Device Telemetry"
          icon={Cpu}
          tone="blue"
          available={mode?.capabilities?.device}
          note={!devices?.authEnabled ? 'DEVICE_AUTH_ENABLED=false' : undefined}
        >
          <Row label="Credentials" value={devices?.total ?? 0} />
          <Row label="Active" value={devices?.active ?? 0} />
          <Row label="MQTT" value={devices?.mqtt?.connected ? 'Connected' : devices?.mqtt?.enabled ? 'Disconnected' : 'Disabled'} />
          <Row label="MQTT broker" value={devices?.mqtt?.brokerUrl || '—'} />
          <div className="mt-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Recent devices</p>
            {devices?.recent?.length ? (
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {devices.recent.slice(0, 6).map((d) => (
                  <div key={d.deviceId} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 truncate max-w-[120px]">{d.deviceId}</span>
                    <span className="text-slate-500">{timeAgo(d.at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600">No device activity</p>
            )}
          </div>
        </SourceCard>

        {/* Public API pollers section */}
        <SourceCard
          title="Public API Pollers"
          icon={Globe}
          tone="violet"
          available={mode?.capabilities?.publicApi}
          note={!publicApi?.available ? 'subsystem not deployed (1.5)' : undefined}
        >
          {!publicApi?.available ? (
            <p className="text-xs text-slate-500">
              The public-grid ingestion subsystem (Sub-module 1.5) is not deployed in this environment.
            </p>
          ) : (
            <>
              <Row label="Enabled sources" value={publicApi.enabled ?? 0} />
              <div className="mt-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Sources</p>
                {publicApi.sources?.length ? (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {publicApi.sources.map((s) => (
                      <div key={s._id || s.providerKey} className="flex items-center justify-between text-xs gap-2">
                        <span className="text-slate-300 truncate">{s.displayName || s.providerKey}</span>
                        <span className={`flex-shrink-0 ${s.lastError ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {s.enabled ? (s.lastError ? 'error' : 'ok') : 'off'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-600">No sources configured</p>
                )}
              </div>
            </>
          )}
        </SourceCard>
      </div>

      {/* Backfill tool (1.4.3) */}
      <div className="content-card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Upload size={16} className="text-emerald-400" /> Backfill / replay historical readings
          </h3>
        </div>
        {!mutate && (
          <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
            <ShieldAlert size={16} className="flex-shrink-0" />
            Read-only access. Imports are restricted to admins.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-[140px_180px_auto] gap-4 mb-4">
          <div>
            <label className={labelClass} htmlFor="bfFormat">Format</label>
            <select id="bfFormat" value={bfFormat} onChange={(e) => setBfFormat(e.target.value)} className={inputClass}>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="bfSource">Default source</label>
            <select id="bfSource" value={bfSource} onChange={(e) => setBfSource(e.target.value)} className={inputClass}>
              <option value="public_api">public_api</option>
              <option value="device">device</option>
              <option value="admin">admin</option>
              <option value="simulated">simulated</option>
            </select>
          </div>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bfDryRun}
                onChange={(e) => setBfDryRun(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-300">Dry run (validate only)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bfConfirmSim}
                onChange={(e) => setBfConfirmSim(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-xs text-slate-300">Confirm simulated (prod)</span>
            </label>
          </div>
        </div>
        <textarea
          value={bfText}
          onChange={(e) => setBfText(e.target.value)}
          disabled={!mutate}
          rows={6}
          placeholder={
            bfFormat === 'csv'
              ? 'nodeId,energyGenerated,energyConsumed,timestamp\n507f1f77bcf86cd799439011,12.5,8.0,2025-01-01T00:00:00Z'
              : '{\n  "readings": [\n    { "nodeId": "507f...", "energyGenerated": 12.5, "energyConsumed": 8.0, "timestamp": "2025-01-01T00:00:00Z" }\n  ]\n}'
          }
          className={`${inputClass} font-mono text-xs resize-y`}
        />
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={handleBackfill}
            disabled={!mutate || bfBusy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-500/90 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
          >
            {bfBusy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {bfDryRun ? 'Run dry run' : 'Import readings'}
          </button>
          {bfResult && (
            <span className="text-xs text-slate-400">
              Requested {bfResult.requested} · Accepted {bfResult.accepted} · Rejected {bfResult.rejected}
            </span>
          )}
        </div>
        {bfResult?.errors?.length > 0 && (
          <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 max-h-40 overflow-y-auto">
            <p className="text-xs font-semibold text-rose-400 mb-1">
              Errors ({bfResult.errorsTruncated ? '50+' : bfResult.errors.length})
            </p>
            {bfResult.errors.map((e, i) => (
              <p key={i} className="text-xs text-slate-400">
                row {e.row}: {e.error}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const StatCard = ({ label, value, tone = 'default' }) => (
  <div className="content-card">
    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</p>
    <p
      className={`text-lg font-bold truncate ${
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white'
      }`}
    >
      {value}
    </p>
  </div>
);

const SourceCard = ({ title, icon: Icon, available = true, locked = false, note, children }) => {
  const tone =
    locked || !available
      ? { ring: 'border-slate-700/40', icon: 'text-slate-500' }
      : { ring: 'border-slate-700/40', icon: 'text-emerald-400' };
  return (
    <div className={`content-card ${tone.ring}`}>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Icon size={16} className={tone.icon} /> {title}
        </h4>
        <div className="flex items-center gap-1.5">
          {locked ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-rose-400">
              <Lock size={11} /> locked
            </span>
          ) : available ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
              <CheckCircle2 size={11} /> allowed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
              <XCircle size={11} /> off
            </span>
          )}
        </div>
      </div>
      {note && <p className="text-[11px] text-amber-400 mb-2">{note}</p>}
      {children}
    </div>
  );
};

const Row = ({ label, value }) => (
  <div className="flex items-center justify-between text-xs py-1 border-b border-slate-800/40 last:border-0">
    <span className="text-slate-500">{label}</span>
    <span className="text-slate-200 font-medium">{value}</span>
  </div>
);

export default Ingestion;
