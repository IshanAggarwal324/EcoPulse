import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  AlertCircle,
  Server as ServerIcon,
  ShieldOff,
  Check,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import EmptyState from '../../components/ui/EmptyState';
import PageLoader from '../../components/ui/PageLoader';
import NodeFormModal from '../../components/admin/NodeFormModal';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import Pagination from '../../components/admin/Pagination';
import RetryCard from '../../components/admin/RetryCard';
import { StatusPill } from '../../utils/adminFormat';
import { NODE_TYPE_LABELS, SOURCE_TYPE_LABELS } from '../../utils/adminFormat';
import { timeAgo, formatDate } from '../../utils/adminFormat';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';

const LIMIT = 20;
const STATUS_OPTIONS = [
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['maintenance', 'Maintenance'],
  ['failed', 'Failed'],
];

const Nodes = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [data, setData] = useState({ nodes: [], meta: { page: 1, limit: LIMIT, total: 0, pages: 1 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formLoading, setFormLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [cascade, setCascade] = useState(false);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const params = { page, limit: LIMIT };
        if (statusFilter) params.status = statusFilter;
        if (sourceFilter) params.sourceType = sourceFilter;
        if (typeFilter) params.nodeType = typeFilter;
        const res = await adminApi.listNodes(params);
        if (!active) return;
        const pages = res.meta?.pages || 1;
        setData({
          nodes: res.data || [],
          meta: res.meta || { page, limit: LIMIT, total: 0, pages: 1 },
        });
        if (page > pages) setPage(Math.max(1, pages));
      } catch (err) {
        if (!active) return;
        setError(err.message || 'Failed to load nodes');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, statusFilter, sourceFilter, typeFilter, reloadKey]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (node) => {
    setEditing(node);
    setFormOpen(true);
  };

  const handleFormSubmit = async (payload) => {
    setFormLoading(true);
    try {
      if (editing) {
        await adminApi.updateNode(editing._id, payload);
        toast.success('Node updated');
      } else {
        await adminApi.createNode(payload);
        toast.success('Node created');
      }
      setFormOpen(false);
      setEditing(null);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to save node');
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await adminApi.deleteNode(deleteTarget._id, cascade ? { cascade: 'true' } : {});
      toast.success(cascade ? 'Node and readings deleted' : 'Node deleted');
      setDeleteTarget(null);
      setCascade(false);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to delete node');
    } finally {
      setDeleteLoading(false);
    }
  };

  const hasFilters = statusFilter || sourceFilter || typeFilter;
  const clearFilters = () => {
    setStatusFilter('');
    setSourceFilter('');
    setTypeFilter('');
    setPage(1);
  };

  const selectClass =
    'px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
  const meta = data.meta || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Nodes"
        subtitle="Energy node inventory and status"
        action={
          mutate ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-emerald-500/15"
            >
              <Plus size={16} /> New node
            </button>
          ) : null
        }
      />

      {!mutate && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
          <ShieldOff size={16} className="flex-shrink-0" />
          You have read-only access. Node mutations are restricted to admins.
        </div>
      )}

      <div className="content-card mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <select aria-label="Filter by node type" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All node types</option>
            {Object.entries(NODE_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Filter by source" value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All sources</option>
            {Object.entries(SOURCE_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Filter by status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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

      {error && data.nodes.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading nodes…" />
      ) : data.nodes.length === 0 && error ? (
        <RetryCard message={error} onRetry={refresh} />
      ) : data.nodes.length === 0 ? (
        <div className="content-card">
          <EmptyState
            illustration="nodes"
            title={hasFilters ? 'No matching nodes' : 'No nodes yet'}
            description={hasFilters ? 'Try adjusting your filters.' : 'Create your first energy node to get started.'}
          />
          {mutate && !hasFilters && (
            <div className="flex justify-center -mt-6 pb-4">
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 rounded-xl text-sm font-medium transition-colors"
              >
                <Plus size={16} /> New node
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="content-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-3 font-semibold">Node</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Owner</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Last reading</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Created</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((n) => (
                  <tr key={n._id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 flex-shrink-0">
                          <ServerIcon size={16} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-slate-200 truncate">{n.name}</p>
                          {n.location && <p className="text-xs text-slate-500 truncate">{n.location}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-300 text-xs font-medium">{NODE_TYPE_LABELS[n.nodeType] || n.nodeType}</p>
                      <p className="text-slate-500 text-xs">{SOURCE_TYPE_LABELS[n.sourceType] || n.sourceType}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill value={n.status} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {n.ownerEmail ? (
                        <div className="min-w-0">
                          <p className="text-slate-300 text-xs truncate">{n.ownerName || '—'}</p>
                          <p className="text-slate-500 text-xs truncate">{n.ownerEmail}</p>
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-400 text-xs" title={n.lastReadingAt || undefined}>
                      {n.lastReadingAt ? (
                        <span className="inline-flex items-center gap-1">
                          <Check size={11} className="text-emerald-400" />
                          {timeAgo(n.lastReadingAt)}
                        </span>
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-400 text-xs">{formatDate(n.createdAt)}</td>
                    <td className="px-4 py-3">
                      {mutate ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(n)}
                            className="p-1.5 text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                            title="Edit node"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(n)}
                            className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                            title="Delete node"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} loading={loading} onChange={setPage} />
        </div>
      )}

      <NodeFormModal
        open={formOpen}
        node={editing}
        loading={formLoading}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSubmit={handleFormSubmit}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete node"
        tone="danger"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        loading={deleteLoading}
        onClose={() => { setDeleteTarget(null); setCascade(false); }}
        onConfirm={handleDeleteConfirm}
      >
        <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={cascade}
            onChange={(e) => setCascade(e.target.checked)}
            disabled={deleteLoading}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-sm text-slate-300">Also delete this node's energy readings</span>
        </label>
      </ConfirmDialog>
    </div>
  );
};

export default Nodes;
