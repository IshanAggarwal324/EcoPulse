import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Gauge,
  RefreshCw,
  Activity,
  Loader2,
  Power,
  RotateCw,
  Save,
  Plus,
  Trash2,
  AlertCircle,
  ShieldOff,
  CheckCircle2,
  XCircle,
  Zap,
  SlidersHorizontal,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import PageLoader from '../../components/ui/PageLoader';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling';
import SimulatorPreviewChart from '../../components/admin/SimulatorPreviewChart';
import { SOURCE_TYPE_LABELS } from '../../utils/adminFormat';
import { timeAgo } from '../../utils/adminFormat';

const POLL_MS = 15000;
const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABELS);
const FAILURE_MODE_OPTIONS = [
  ['offline', 'Offline'],
  ['reduced_output', 'Reduced output'],
  ['spike', 'Spike'],
  ['intermittent', 'Intermittent'],
];

const inputClass =
  'w-full px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5';

const FAILURE_TONE = {
  offline: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  reduced_output: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  spike: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30',
  intermittent: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
};

const cloneConfig = (config) => ({
  enabled: config?.enabled ?? true,
  intervalMs: config?.intervalMs ?? 5000,
  jitterMs: config?.jitterMs ?? 1500,
  profiles: (config?.profiles || []).map((p) => ({ ...p })),
  failureModes: (config?.failureModes || []).map((m) => ({ ...m })),
});

const Simulator = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [previewSource, setPreviewSource] = useState('solar');
  const [preview, setPreview] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [readings, setReadings] = useState([]);
  const mounted = useRef(true);

  const loadConfig = useCallback(async () => {
    try {
      const res = await adminApi.getSimulatorConfig();
      if (!mounted.current) return;
      setConfig(res.data?.config || null);
      setStatus(res.data?.status || null);
      setDraft(cloneConfig(res.data?.config));
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err.message || 'Failed to load simulator config');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  const loadStatusAndReadings = useCallback(async () => {
    try {
      const [cfgRes, readingsRes] = await Promise.all([
        adminApi.getSimulatorConfig(),
        adminApi.getSimulatorReadings(15).catch(() => ({ data: [] })),
      ]);
      if (!mounted.current) return;
      setStatus(cfgRes.data?.status || null);
      setReadings(readingsRes.data || []);
    } catch {
      /* silent background refresh */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadConfig();
    return () => {
      mounted.current = false;
    };
  }, [loadConfig]);

  useVisibilityPolling(loadStatusAndReadings, POLL_MS, autoRefresh);

  // Load node options for the failure-mode node targeter.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await adminApi.listNodes({ limit: 100 });
        if (active) setNodes(res.data || []);
      } catch {
        /* optional */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Load the schedule preview whenever the selected source type changes.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await adminApi.getSimulatorPreview(previewSource);
        if (active) setPreview(res.data?.points || []);
      } catch {
        if (active) setPreview([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [previewSource]);

  const handleToggleEnabled = async () => {
    if (!mutate || !draft) return;
    setToggling(true);
    const next = !draft.enabled;
    try {
      const res = await adminApi.updateSimulatorConfig({ enabled: next });
      if (!mounted.current) return;
      setConfig(res.data?.config || config);
      setStatus(res.data?.status || status);
      setDraft((d) => ({ ...d, enabled: next }));
      toast.success(next ? 'Simulator enabled' : 'Simulator paused');
    } catch (err) {
      toast.error(err.message || 'Failed to toggle simulator');
    } finally {
      if (mounted.current) setToggling(false);
    }
  };

  const handleSave = async () => {
    if (!mutate || !draft) return;
    setSaving(true);
    try {
      const res = await adminApi.updateSimulatorConfig({
        intervalMs: Number(draft.intervalMs),
        jitterMs: Number(draft.jitterMs),
        profiles: draft.profiles,
        failureModes: draft.failureModes,
      });
      if (!mounted.current) return;
      setConfig(res.data?.config || config);
      setStatus(res.data?.status || status);
      setDraft(cloneConfig(res.data?.config));
      toast.success('Simulator configuration saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save configuration');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const handleRestart = async () => {
    if (!mutate) return;
    setRestarting(true);
    try {
      const res = await adminApi.restartSimulator();
      if (!mounted.current) return;
      setStatus(res.data || status);
      toast.success('Simulator restarted');
    } catch (err) {
      toast.error(err.message || 'Failed to restart simulator');
    } finally {
      if (mounted.current) setRestarting(false);
    }
  };

  const handleReset = async () => {
    if (!mutate) return;
    setResetting(true);
    try {
      const res = await adminApi.resetSimulatorConfig();
      if (!mounted.current) return;
      setConfig(res.data?.config || config);
      setStatus(res.data?.status || status);
      setDraft(cloneConfig(res.data?.config));
      toast.success('Configuration reset to defaults');
    } catch (err) {
      toast.error(err.message || 'Failed to reset configuration');
    } finally {
      if (mounted.current) setResetting(false);
    }
  };

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    if (Number(draft.intervalMs) !== config.intervalMs) return true;
    if (Number(draft.jitterMs) !== config.jitterMs) return true;
    if (JSON.stringify(draft.profiles) !== JSON.stringify(config.profiles)) return true;
    if (JSON.stringify(draft.failureModes) !== JSON.stringify(config.failureModes)) return true;
    return false;
  }, [config, draft]);

  if (loading) {
    return (
      <div className="page-section w-full">
        <SectionTitle title="Simulator" subtitle="Configurable grid simulator" />
        <PageLoader message="Loading simulator…" />
      </div>
    );
  }

  const embedded = status?.embedded;
  const running = status?.running;
  const enabled = draft?.enabled ?? config?.enabled;

  const bannerTone = !embedded
    ? { label: 'CLI mode', sub: 'Run a separate simulator process', cls: 'text-slate-300 bg-slate-700/20 border-slate-600/40', Icon: Activity }
    : !enabled
      ? { label: 'Paused', sub: 'Enabled flag is off', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30', Icon: Power }
      : running
        ? { label: 'Running', sub: `${status.nodes ?? 0} nodes · ~${status.intervalMs ?? '—'}ms interval`, cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', Icon: CheckCircle2 }
        : { label: 'Not running', sub: 'Enabled but no active runner', cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30', Icon: XCircle };

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Simulator"
        subtitle="Profiles, schedules, failure modes, and runtime control"
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
              onClick={loadStatusAndReadings}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        }
      />

      {!mutate && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
          <ShieldOff size={16} className="flex-shrink-0" />
          You have read-only access. Simulator mutations are restricted to admins.
        </div>
      )}

      {/* Status banner */}
      <div className={`flex items-center justify-between gap-3 p-4 rounded-2xl border mb-6 ${bannerTone.cls}`}>
        <div className="flex items-center gap-3 min-w-0">
          <bannerTone.Icon size={20} className="flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold">{bannerTone.label}</p>
            <p className="text-xs opacity-80 truncate">{bannerTone.sub}</p>
          </div>
        </div>
        {mutate && (
          <button
            type="button"
            onClick={handleToggleEnabled}
            disabled={toggling}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl transition-all disabled:opacity-50 ${
              enabled
                ? 'bg-amber-500/90 hover:bg-amber-500 text-white'
                : 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white shadow-lg shadow-emerald-500/15'
            }`}
          >
            {toggling ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}
            {enabled ? 'Pause' : 'Start'}
          </button>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Embedded" value={embedded ? 'Yes' : 'No'} />
        <StatCard label="Running" value={running ? 'Yes' : 'No'} tone={running ? 'good' : 'default'} />
        <StatCard label="Nodes" value={status?.nodes ?? '—'} />
        <StatCard label="Ticks" value={(status?.ticks ?? 0).toLocaleString()} />
        <StatCard label="Readings" value={(status?.readingsEmitted ?? 0).toLocaleString()} />
        <StatCard label="Started" value={status?.startedAt ? timeAgo(status.startedAt) : '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* General settings */}
        <div className="content-card">
          <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-emerald-400" /> General settings
          </h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className={labelClass} htmlFor="simInterval">Tick interval (ms)</label>
              <input
                id="simInterval"
                type="number"
                min="1000"
                step="500"
                disabled={!mutate}
                value={draft?.intervalMs ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, intervalMs: Number(e.target.value) }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="simJitter">Jitter (ms)</label>
              <input
                id="simJitter"
                type="number"
                min="0"
                step="100"
                disabled={!mutate}
                value={draft?.jitterMs ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, jitterMs: Number(e.target.value) }))}
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!mutate || saving || !dirty}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-500/90 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save changes
            </button>
            <button
              type="button"
              onClick={handleRestart}
              disabled={!mutate || restarting || !embedded}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors disabled:opacity-50"
              title={embedded ? 'Restart the embedded runner' : 'Only available when embedded'}
            >
              {restarting ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
              Restart
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!mutate || resetting}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              {resetting ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Reset to defaults
            </button>
          </div>
          {dirty && mutate && (
            <p className="text-xs text-amber-400 mt-3 flex items-center gap-1.5">
              <AlertCircle size={12} /> You have unsaved changes.
            </p>
          )}
        </div>

        {/* Schedule preview */}
        <div className="content-card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Activity size={16} className="text-emerald-400" /> Diurnal schedule preview
            </h3>
            <select
              aria-label="Preview source type"
              value={previewSource}
              onChange={(e) => setPreviewSource(e.target.value)}
              className="px-3 py-1.5 bg-slate-950 border border-slate-700/60 rounded-lg text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              {SOURCE_TYPES.map((s) => (
                <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="h-[220px]">
            <SimulatorPreviewChart data={preview} />
          </div>
        </div>
      </div>

      {/* Profile editor */}
      <div className="content-card mb-6">
        <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
          <Gauge size={16} className="text-emerald-400" /> Capacity profiles
        </h3>
        <div className="space-y-4">
          {draft?.profiles.map((p, idx) => (
            <div key={p.sourceType} className="grid grid-cols-1 md:grid-cols-[140px_1fr_1fr] gap-4 items-center">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-semibold border border-emerald-500/25">
                  {SOURCE_TYPE_LABELS[p.sourceType] || p.sourceType}
                </span>
              </div>
              <CapacitySlider
                label="Generate (kW)"
                value={p.capacityGenerateKw}
                max={120}
                disabled={!mutate}
                onChange={(v) => setDraft((d) => {
                  const profiles = [...d.profiles];
                  profiles[idx] = { ...profiles[idx], capacityGenerateKw: v };
                  return { ...d, profiles };
                })}
              />
              <CapacitySlider
                label="Consume (kW)"
                value={p.capacityConsumeKw}
                max={150}
                disabled={!mutate}
                onChange={(v) => setDraft((d) => {
                  const profiles = [...d.profiles];
                  profiles[idx] = { ...profiles[idx], capacityConsumeKw: v };
                  return { ...d, profiles };
                })}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Failure modes */}
      <div className="content-card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Zap size={16} className="text-emerald-400" /> Failure modes
          </h3>
          {mutate && (
            <button
              type="button"
              onClick={() => setDraft((d) => ({
                ...d,
                failureModes: [
                  ...d.failureModes,
                  {
                    label: '',
                    target: 'source',
                    nodeId: null,
                    sourceType: 'solar',
                    mode: 'reduced_output',
                    probability: 0.1,
                    durationTicks: 3,
                    outputMultiplier: 0.3,
                    enabled: true,
                  },
                ],
              }))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 border border-emerald-500/25 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors"
            >
              <Plus size={14} /> Add mode
            </button>
          )}
        </div>

        {draft?.failureModes.length === 0 ? (
          <p className="text-sm text-slate-500 py-2">
            No failure modes configured. Add one to simulate outages, reduced output, spikes, or intermittent drops.
          </p>
        ) : (
          <div className="space-y-3">
            {draft?.failureModes.map((m, idx) => (
              <FailureModeRow
                key={idx}
                mode={m}
                nodes={nodes}
                disabled={!mutate}
                onChange={(updated) => setDraft((d) => {
                  const failureModes = [...d.failureModes];
                  failureModes[idx] = updated;
                  return { ...d, failureModes };
                })}
                onRemove={() => setDraft((d) => ({
                  ...d,
                  failureModes: d.failureModes.filter((_, i) => i !== idx),
                }))}
              />
            ))}
          </div>
        )}
      </div>

      {/* Live readings */}
      <div className="content-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Activity size={16} className="text-emerald-400" /> Live readings
            {running && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
          </h3>
          <span className="text-xs text-slate-500">{readings.length} recent</span>
        </div>
        {readings.length === 0 ? (
          <p className="text-sm text-slate-500 py-2">
            {embedded ? 'Waiting for the embedded runner to emit readings…' : 'Start the embedded simulator to see live readings.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-3 py-2 font-semibold">Node</th>
                  <th className="px-3 py-2 font-semibold hidden sm:table-cell">Source</th>
                  <th className="px-3 py-2 font-semibold text-right">Generated</th>
                  <th className="px-3 py-2 font-semibold text-right">Consumed</th>
                  <th className="px-3 py-2 font-semibold hidden md:table-cell">Failures</th>
                  <th className="px-3 py-2 font-semibold text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((r, i) => (
                  <tr key={`${r.nodeId}-${r.timestamp}-${i}`} className="border-b border-slate-800/50 last:border-0">
                    <td className="px-3 py-2 text-slate-300 text-xs truncate max-w-[160px]">{r.name || r.nodeId}</td>
                    <td className="px-3 py-2 hidden sm:table-cell text-slate-400 text-xs">{r.sourceType || '—'}</td>
                    <td className="px-3 py-2 text-right text-emerald-400 text-xs font-medium">{r.energyGenerated} kW</td>
                    <td className="px-3 py-2 text-right text-rose-400 text-xs font-medium">{r.energyConsumed} kW</td>
                    <td className="px-3 py-2 hidden md:table-cell">
                      {r.failures?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {r.failures.map((f, j) => (
                            <span key={j} className={`px-1.5 py-0.5 rounded text-[10px] border ${FAILURE_TONE[f] || FAILURE_TONE.offline}`}>
                              {f}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500 text-xs">{timeAgo(r.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const StatCard = ({ label, value, tone = 'default' }) => (
  <div className="content-card">
    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</p>
    <p className={`text-lg font-bold truncate ${tone === 'good' ? 'text-emerald-400' : 'text-white'}`}>{value}</p>
  </div>
);

const CapacitySlider = ({ label, value, max, disabled, onChange }) => (
  <div>
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-xs font-semibold text-white tabular-nums">{Number(value).toFixed(0)} kW</span>
    </div>
    <input
      type="range"
      min={0}
      max={max}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-emerald-500 cursor-pointer disabled:opacity-50"
    />
  </div>
);

const FailureModeRow = ({ mode, nodes, disabled, onChange, onRemove }) => {
  const set = (field, val) => onChange({ ...mode, [field]: val });
  const selectClass =
    'w-full px-2.5 py-2 bg-slate-950 border border-slate-700/60 rounded-lg text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-start justify-between gap-2 mb-3">
        <input
          type="text"
          value={mode.label || ''}
          disabled={disabled}
          onChange={(e) => set('label', e.target.value)}
          placeholder="Label (optional)"
          className="flex-1 px-2.5 py-1.5 bg-transparent border-0 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={mode.enabled !== false}
              disabled={disabled}
              onChange={(e) => set('enabled', e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-[11px] text-slate-400">Enabled</span>
          </label>
          {disabled ? null : (
            <button
              type="button"
              onClick={onRemove}
              className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
              title="Remove failure mode"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <span className="text-[11px] text-slate-500">Target</span>
          <select value={mode.target} disabled={disabled} onChange={(e) => set('target', e.target.value)} className={selectClass}>
            <option value="source">All of source</option>
            <option value="node">Specific node</option>
          </select>
        </div>
        <div>
          <span className="text-[11px] text-slate-500">{mode.target === 'node' ? 'Node' : 'Source'}</span>
          {mode.target === 'node' ? (
            <select value={mode.nodeId || ''} disabled={disabled} onChange={(e) => set('nodeId', e.target.value || null)} className={selectClass}>
              <option value="">Select node…</option>
              {nodes.map((n) => (
                <option key={n._id} value={n._id}>{n.name}</option>
              ))}
            </select>
          ) : (
            <select value={mode.sourceType || 'solar'} disabled={disabled} onChange={(e) => set('sourceType', e.target.value)} className={selectClass}>
              {SOURCE_TYPES.map((s) => (
                <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <span className="text-[11px] text-slate-500">Mode</span>
          <select value={mode.mode} disabled={disabled} onChange={(e) => set('mode', e.target.value)} className={selectClass}>
            {FAILURE_MODE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <span className="text-[11px] text-slate-500">Multiplier</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={mode.outputMultiplier}
            disabled={disabled}
            onChange={(e) => set('outputMultiplier', Number(e.target.value))}
            className={selectClass}
          />
        </div>
        <div className="col-span-2 md:col-span-2">
          <span className="text-[11px] text-slate-500">Probability / tick</span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={mode.probability}
              disabled={disabled}
              onChange={(e) => set('probability', Number(e.target.value))}
              className="flex-1 accent-amber-500 cursor-pointer disabled:opacity-50"
            />
            <span className="text-xs font-semibold text-white tabular-nums w-10 text-right">
              {Math.round((mode.probability ?? 0) * 100)}%
            </span>
          </div>
        </div>
        <div className="col-span-2 md:col-span-2">
          <span className="text-[11px] text-slate-500">Duration (ticks)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={mode.durationTicks}
            disabled={disabled}
            onChange={(e) => set('durationTicks', Math.max(1, Number(e.target.value)))}
            className={selectClass}
          />
        </div>
      </div>
    </div>
  );
};

export default Simulator;
