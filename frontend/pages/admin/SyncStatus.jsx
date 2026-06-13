import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw,
  Zap,
  Boxes,
  Link2,
  Link2Off,
  Gauge,
  Hash,
  Activity,
  Clock,
  ShieldOff,
  Loader2,
  TrendingUp,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';
import { timeAgo, formatDateTime } from '../../utils/adminFormat';

const POLL_MS = 15000;

const SyncStatus = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [forceLoading, setForceLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const mounted = useRef(true);

  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await adminApi.getSyncStatus();
      if (!mounted.current) return;
      setStatus(res.data);
      setLastUpdated(new Date());
    } catch (err) {
      if (!mounted.current) return;
      setStatus({ connected: false, error: err.message });
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadStatus();
    return () => {
      mounted.current = false;
    };
  }, [loadStatus]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(loadStatus, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, loadStatus]);

  const handleForceSync = async () => {
    setForceLoading(true);
    try {
      const res = await adminApi.forceSync();
      const result = res.data || {};
      toast.success(`Sync complete — ${result.indexed ?? 0} event(s) indexed`);
      await loadStatus();
    } catch (err) {
      toast.error(err.message || 'Force sync failed');
    } finally {
      setForceLoading(false);
    }
  };

  const connected = status?.connected;
  const healthy = status?.isSyncHealthy;
  const lag = status?.syncLagBlocks;

  const overallTone = !connected
    ? { label: 'Disconnected', cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30' }
    : healthy
      ? { label: 'Healthy', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' }
      : { label: 'Degraded', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' };

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Sync Status"
        subtitle="Blockchain indexer health and control"
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
              onClick={loadStatus}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        }
      />

      {!mutate && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
          <ShieldOff size={16} className="flex-shrink-0" />
          You have read-only access. Force sync is restricted to admins.
        </div>
      )}

      {/* Overall status banner */}
      <div className={`flex items-center justify-between gap-3 p-4 rounded-2xl border mb-6 ${overallTone.cls}`}>
        <div className="flex items-center gap-3">
          {connected ? <Link2 size={20} /> : <Link2Off size={20} />}
          <div>
            <p className="text-sm font-bold">{overallTone.label}</p>
            <p className="text-xs opacity-80">
              {connected
                ? `${status.chainName || 'Blockchain'} · chainId ${status.chainId ?? '—'}`
                : status?.error || 'Unable to reach the blockchain provider.'}
            </p>
          </div>
        </div>
        {mutate && (
          <button
            type="button"
            onClick={handleForceSync}
            disabled={forceLoading || !connected}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-emerald-500/15"
          >
            {forceLoading ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
            Force sync
          </button>
        )}
      </div>

      {/* Stat cards */}
      {loading && !status ? null : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Boxes} label="Head block" value={connected ? (status.blockNumber?.toLocaleString() ?? '—') : '—'} />
          <StatCard
            icon={Hash}
            label="Last synced"
            value={connected ? (status.lastSyncedBlock?.toLocaleString() ?? '0') : '—'}
          />
          <StatCard
            icon={Gauge}
            label="Sync lag"
            value={lag != null ? `${lag.toLocaleString()} blocks` : '—'}
            tone={lag != null && lag > 50 ? 'warn' : 'default'}
          />
          <StatCard icon={TrendingUp} label="Trades indexed" value={connected ? (status.tradeCount?.toLocaleString() ?? '0') : '—'} />
          <StatCard icon={Hash} label="Next listing ID" value={connected ? (status.nextListingId?.toLocaleString() ?? '—') : '—'} />
          <StatCard
            icon={Clock}
            label="Last sync run"
            value={status?.lastSync?.at ? timeAgo(status.lastSync.at) : 'Never'}
            sub={status?.lastSync?.status ? `Status: ${status.lastSync.status}` : undefined}
          />
          <StatCard
            icon={Zap}
            label="Last sync indexed"
            value={status?.lastSync?.indexed != null ? String(status.lastSync.indexed) : '—'}
          />
        </div>
      )}

      {/* Last sync detail */}
      {status?.lastSync && (
        <div className="content-card">
          <h3 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <Activity size={16} className="text-emerald-400" /> Last sync details
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            <DetailRow label="Status" value={status.lastSync.status || '—'} />
            <DetailRow label="Message" value={status.lastSync.message || '—'} />
            <DetailRow label="Events indexed" value={String(status.lastSync.indexed ?? 0)} />
            <DetailRow label="Synced to block" value={String(status.lastSync.lastSyncedBlock ?? 0)} />
            <DetailRow label="Completed at" value={status.lastSync.at ? formatDateTime(status.lastSync.at) : '—'} />
          </dl>
        </div>
      )}

      {lastUpdated && (
        <p className="text-xs text-slate-600 mt-4 text-center">
          Last updated {timeAgo(lastUpdated)}{autoRefresh ? ' · auto-refreshing every 15s' : ''}
        </p>
      )}
    </div>
  );
};

const StatCard = ({ icon: Icon, label, value, sub, tone = 'default' }) => (
  <div className="content-card">
    <div className="flex items-center gap-2 mb-2">
      <div className={`p-1.5 rounded-lg ${tone === 'warn' ? 'bg-amber-500/10' : 'bg-emerald-500/10'}`}>
        <Icon size={15} className={tone === 'warn' ? 'text-amber-400' : 'text-emerald-400'} />
      </div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
    </div>
    <p className="text-lg font-bold text-white truncate">{value}</p>
    {sub && <p className="text-[11px] text-slate-500 mt-0.5">{sub}</p>}
  </div>
);

const DetailRow = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 py-1.5 border-b border-slate-800/50 last:border-0">
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd className="text-sm text-slate-200 font-medium text-right truncate max-w-[60%]" title={value}>{value}</dd>
  </div>
);

export default SyncStatus;
