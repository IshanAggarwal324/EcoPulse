import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertCircle,
  FileText,
  RefreshCw,
  ShieldOff,
  RotateCw,
  Mail,
  MessageSquare,
  Clock,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import EmptyState from '../../components/ui/EmptyState';
import PageLoader from '../../components/ui/PageLoader';
import Pagination from '../../components/admin/Pagination';
import RetryCard from '../../components/admin/RetryCard';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import {
  StatusPill,
  PERIOD_LABELS,
  SCOPE_LABELS,
  DELIVERY_LABELS,
  formatDateTime,
  timeAgo,
} from '../../utils/adminFormat';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';

const LIMIT = 20;

const ReportJobs = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [data, setData] = useState({ jobs: [], meta: { page: 1, limit: LIMIT, total: 0, pages: 1 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [retryTarget, setRetryTarget] = useState(null);
  const [retryLoading, setRetryLoading] = useState(false);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const params = { page, limit: LIMIT };
        if (statusFilter) params.status = statusFilter;
        if (deliveryFilter) params.delivery = deliveryFilter;
        if (periodFilter) params.period = periodFilter;
        const res = await adminApi.listReportJobs(params);
        if (!active) return;
        setData({
          jobs: res.data || [],
          meta: res.meta || { page, limit: LIMIT, total: 0, pages: 1 },
        });
      } catch (err) {
        if (!active) return;
        setError(err.message || 'Failed to load report jobs');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, statusFilter, deliveryFilter, periodFilter, reloadKey]);

  const handleRetryConfirm = async () => {
    if (!retryTarget) return;
    setRetryLoading(true);
    try {
      const res = await adminApi.retryReportJob(retryTarget._id);
      toast.success(res.data?.message || 'Report email re-sent');
      setRetryTarget(null);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Retry failed');
    } finally {
      setRetryLoading(false);
    }
  };

  const hasFilters = statusFilter || deliveryFilter || periodFilter;
  const clearFilters = () => {
    setStatusFilter('');
    setDeliveryFilter('');
    setPeriodFilter('');
    setPage(1);
  };

  const selectClass =
    'px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
  const meta = data.meta || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Report Jobs"
        subtitle="Report generation queue and delivery"
        action={
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-400 text-xs font-medium">
            <FileText size={14} />
            {meta.total ?? 0} total
          </span>
        }
      />

      {!mutate && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
          <ShieldOff size={16} className="flex-shrink-0" />
          You have read-only access. Retries are restricted to admins.
        </div>
      )}

      <div className="content-card mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <select aria-label="Filter by status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </select>
          <select aria-label="Filter by delivery" value={deliveryFilter} onChange={(e) => { setDeliveryFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All delivery</option>
            <option value="chat">Chat</option>
            <option value="email">Email</option>
          </select>
          <select aria-label="Filter by period" value={periodFilter} onChange={(e) => { setPeriodFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All periods</option>
            {Object.entries(PERIOD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="px-3 py-2.5 text-sm font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && data.jobs.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading report jobs…" />
      ) : data.jobs.length === 0 && error ? (
        <RetryCard message={error} onRetry={refresh} />
      ) : data.jobs.length === 0 ? (
        <div className="content-card">
          <EmptyState
            illustration="default"
            title={hasFilters ? 'No matching report jobs' : 'No report jobs yet'}
            description={hasFilters ? 'Try adjusting your filters.' : 'Generated reports will appear here.'}
          />
        </div>
      ) : (
        <div className="content-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Report</th>
                  <th className="px-4 py-3 font-semibold">Delivery</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Sent</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => {
                  const user = j.userId || {};
                  const canRetry = mutate && j.status === 'failed' && j.delivery === 'email';
                  return (
                    <tr key={j._id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-200 truncate">{user.name || 'Unknown user'}</p>
                          <p className="text-xs text-slate-500 truncate">{user.email || '—'}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <p className="text-slate-300 text-xs">{PERIOD_LABELS[j.period] || j.period}</p>
                        <p className="text-slate-500 text-xs">{SCOPE_LABELS[j.scope] || j.scope}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs text-slate-300">
                          {j.delivery === 'email' ? <Mail size={12} className="text-slate-500" /> : <MessageSquare size={12} className="text-slate-500" />}
                          {DELIVERY_LABELS[j.delivery] || j.delivery}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <StatusPill value={j.status} />
                          {j.status === 'failed' && j.error && (
                            <span className="text-[10px] text-rose-400/80 max-w-[180px] truncate" title={j.error}>
                              {j.error}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-slate-400 text-xs" title={j.sentAt || j.createdAt || undefined}>
                        {j.status === 'sent' && j.sentAt ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock size={11} className="text-emerald-400" />
                            {timeAgo(j.sentAt)}
                          </span>
                        ) : j.status === 'pending' ? (
                          <span className="text-amber-400/80">Queued</span>
                        ) : (
                          formatDateTime(j.createdAt)
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          {canRetry ? (
                            <button
                              type="button"
                              onClick={() => setRetryTarget(j)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-lg transition-colors"
                              title="Retry sending report email"
                            >
                              <RotateCw size={13} /> Retry
                            </button>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} loading={loading} onChange={setPage} />
        </div>
      )}

      <ConfirmDialog
        open={!!retryTarget}
        title="Retry report email"
        tone="default"
        message={
          retryTarget
            ? `Re-send the ${PERIOD_LABELS[retryTarget.period] || retryTarget.period} report email to ${retryTarget.userId?.email || 'this user'}?`
            : ''
        }
        confirmLabel="Re-send email"
        loading={retryLoading}
        onClose={() => setRetryTarget(null)}
        onConfirm={handleRetryConfirm}
      />
    </div>
  );
};

export default ReportJobs;
