import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Users as UsersIcon,
  Server,
  ArrowRightLeft,
  FileText,
  RefreshCw,
  ScrollText,
  Activity,
  ArrowUpRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Lock,
  Gauge,
  Database,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import RoleBadge from '../../components/admin/RoleBadge';
import { useAuth } from '../../context/AuthContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';

const MODULE_CARDS = [
  {
    to: '/admin/users',
    label: 'Users',
    description: 'Roles, bans, and account management',
    icon: UsersIcon,
    phase: 'Phase 4',
  },
  {
    to: '/admin/nodes',
    label: 'Nodes',
    description: 'Energy node inventory and status',
    icon: Server,
    phase: 'Phase 4',
  },
  {
    to: '/admin/trades',
    label: 'Trades',
    description: 'On-chain trade history and explorer links',
    icon: ArrowRightLeft,
    phase: 'Phase 4',
  },
  {
    to: '/admin/report-jobs',
    label: 'Report Jobs',
    description: 'Report generation queue and retries',
    icon: FileText,
    phase: 'Phase 4',
  },
  {
    to: '/admin/sync',
    label: 'Sync Status',
    description: 'Blockchain indexer health and force sync',
    icon: RefreshCw,
    phase: 'Phase 4',
  },
  {
    to: '/admin/simulator',
    label: 'Simulator',
    description: 'Grid profiles, schedules, and failure modes',
    icon: Gauge,
    phase: 'Phase 6',
  },
  {
    to: '/admin/ingestion',
    label: 'Ingestion',
    description: 'Mode, telemetry sources, and backfill',
    icon: Database,
    phase: 'Module 1.4',
  },
  {
    to: '/admin/audit-logs',
    label: 'Audit Logs',
    description: 'Immutable operational trail',
    icon: ScrollText,
    phase: 'Phase 2',
  },
  {
    to: '/admin/health',
    label: 'System Health',
    description: 'AI, GenAI, MongoDB & Sepolia probes',
    icon: Activity,
    phase: 'Phase 5',
  },
];

const SyncBadge = ({ status }) => {
  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
        <Loader2 size={13} className="animate-spin" /> Checking…
      </span>
    );
  }
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
        <CheckCircle2 size={13} /> Connected
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-rose-400">
        <XCircle size={13} /> Unreachable
      </span>
    );
  }
  return null;
};

const AdminHome = () => {
  const { user } = useAuth();
  const [syncState, setSyncState] = useState('loading');
  const [syncData, setSyncData] = useState(null);
  const mounted = useRef(true);

  const checkSync = useCallback(async () => {
    setSyncState('loading');
    try {
      const res = await adminApi.getSyncStatus();
      if (!mounted.current) return;
      setSyncData(res.data);
      setSyncState('ok');
    } catch {
      if (!mounted.current) return;
      setSyncData(null);
      setSyncState('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    checkSync();
    return () => {
      mounted.current = false;
    };
  }, [checkSync]);

  const mutate = canMutate(user);

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Admin Overview"
        subtitle="Operational control center for EcoPulse"
        action={<RoleBadge role={user?.role} />}
      />

      <section className="content-card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-white mb-1">
              Welcome back, {user?.name?.split(' ')[0] || 'Admin'}
            </h3>
            <p className="text-sm text-slate-400">
              Signed in as <span className="text-slate-300 font-medium">{user?.email}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {mutate ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold">
                Full access
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-semibold">
                <Lock size={12} /> Read-only access
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="content-card mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <RefreshCw size={16} className="text-emerald-400" /> Blockchain Sync
          </h3>
          <SyncBadge status={syncState} />
        </div>
        {syncState === 'ok' && syncData ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Metric label="Chain" value={syncData.chainName || syncData.chainId || '—'} />
            <Metric label="Block" value={syncData.blockNumber ?? '—'} />
            <Metric label="Last synced" value={syncData.lastSyncedBlock ?? '—'} />
            <Metric
              label="Lag"
              value={syncData.syncLagBlocks != null ? `${syncData.syncLagBlocks} blocks` : '—'}
            />
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            {syncState === 'error'
              ? 'Unable to reach the sync service. The backend may be offline.'
              : 'Reading indexer status…'}
          </p>
        )}
        <button
          type="button"
          onClick={checkSync}
          disabled={syncState === 'loading'}
          className="mt-4 text-xs font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
        >
          Refresh
        </button>
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULE_CARDS.map(({ to, label, description, icon: Icon, phase }) => (
          <Link
            key={to}
            to={to}
            className="content-card group hover:border-emerald-500/40 transition-all duration-200 cursor-pointer"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="p-2.5 bg-emerald-500/10 rounded-xl group-hover:bg-emerald-500/20 transition-colors">
                <Icon className="text-emerald-400" size={20} />
              </div>
              <ArrowUpRight
                size={18}
                className="text-slate-600 group-hover:text-emerald-400 transition-colors"
              />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-base font-semibold text-white">{label}</h4>
              <span className="px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-700/50 text-slate-500 text-[10px] font-medium">
                {phase}
              </span>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
};

const Metric = ({ label, value }) => (
  <div>
    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5">{label}</p>
    <p className="text-sm font-semibold text-slate-200 truncate">{value}</p>
  </div>
);

export default AdminHome;
