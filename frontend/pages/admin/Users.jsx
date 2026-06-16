import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Ban,
  ShieldCheck,
  Trash2,
  Loader2,
  AlertCircle,
  Users as UsersIcon,
  ShieldOff,
  Copy,
  Check,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import EmptyState from '../../components/ui/EmptyState';
import PageLoader from '../../components/ui/PageLoader';
import RoleBadge from '../../components/admin/RoleBadge';
import BanUserModal from '../../components/admin/BanUserModal';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import Pagination from '../../components/admin/Pagination';
import RetryCard from '../../components/admin/RetryCard';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';
import { canMutate } from '../../utils/adminNav';
import { shortWallet, formatDate } from '../../utils/adminFormat';

const LIMIT = 20;
const ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'admin', label: 'Admin' },
];

const Users = () => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const mutate = canMutate(currentUser);

  const [data, setData] = useState({ users: [], meta: { page: 1, limit: LIMIT, total: 0, pages: 1 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [bannedFilter, setBannedFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [banTarget, setBanTarget] = useState(null);
  const [banLoading, setBanLoading] = useState(false);
  const [unbanTarget, setUnbanTarget] = useState(null);
  const [unbanLoading, setUnbanLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [roleBusyId, setRoleBusyId] = useState('');
  const [roleTarget, setRoleTarget] = useState(null);
  const [copiedId, setCopiedId] = useState('');

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const copyWallet = async (u) => {
    if (!u.walletAddress) return;
    try {
      await navigator.clipboard.writeText(u.walletAddress);
      setCopiedId(u._id);
      toast.success('Wallet address copied');
      setTimeout(() => setCopiedId(''), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const params = { page, limit: LIMIT };
        if (search) params.search = search;
        if (roleFilter) params.role = roleFilter;
        if (bannedFilter) params.isBanned = bannedFilter;
        const res = await adminApi.listUsers(params);
        if (!active) return;
        const pages = res.meta?.pages || 1;
        setData({
          users: res.data || [],
          meta: res.meta || { page, limit: LIMIT, total: 0, pages: 1 },
        });
        if (page > pages) setPage(Math.max(1, pages));
      } catch (err) {
        if (!active) return;
        setError(err.message || 'Failed to load users');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, search, roleFilter, bannedFilter, reloadKey]);

  const isSelf = (u) => !!currentUser && u._id === currentUser._id;

  const applyRoleChange = async (u, role) => {
    setRoleBusyId(u._id);
    try {
      await adminApi.setUserRole(u._id, role);
      toast.success(`Role updated to "${role}"`);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to update role');
    } finally {
      setRoleBusyId('');
    }
  };

  // Admin grant/revoke is high-impact: confirm before applying. Routine
  // user <-> moderator changes apply immediately.
  const requestRoleChange = (u, nextRole) => {
    if (nextRole === u.role) return;
    if (nextRole === 'admin' || u.role === 'admin') {
      setRoleTarget({ user: u, nextRole });
    } else {
      applyRoleChange(u, nextRole);
    }
  };

  const handleRoleConfirm = async () => {
    if (!roleTarget) return;
    const { user, nextRole } = roleTarget;
    setRoleTarget(null);
    await applyRoleChange(user, nextRole);
  };

  const handleBanConfirm = async (reason) => {
    if (!banTarget) return;
    setBanLoading(true);
    try {
      await adminApi.banUser(banTarget._id, reason);
      toast.success('User has been banned');
      setBanTarget(null);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to ban user');
    } finally {
      setBanLoading(false);
    }
  };

  const handleUnbanConfirm = async () => {
    if (!unbanTarget) return;
    setUnbanLoading(true);
    try {
      await adminApi.unbanUser(unbanTarget._id);
      toast.success('User has been unbanned');
      setUnbanTarget(null);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to unban user');
    } finally {
      setUnbanLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await adminApi.deleteUser(deleteTarget._id);
      toast.success('User has been deactivated');
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Failed to deactivate user');
    } finally {
      setDeleteLoading(false);
    }
  };

  const clearFilters = () => {
    setSearchInput('');
    setRoleFilter('');
    setBannedFilter('');
    setPage(1);
  };

  const hasFilters = search || roleFilter || bannedFilter;
  const meta = data.meta || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Users"
        subtitle="Manage accounts, roles, and access"
        action={
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-400 text-xs font-medium">
            <UsersIcon size={14} />
            {meta.total ?? 0} total
          </span>
        }
      />

      <p className="text-xs text-amber-300/80 -mt-2 mb-4">
        Always verify a wallet address before sending funds — clipboard malware can silently swap copied addresses.
      </p>

      {!mutate && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-sm">
          <ShieldOff size={16} className="flex-shrink-0" />
          You have read-only access. Mutation actions are restricted to admins.
        </div>
      )}

      <div className="content-card mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              aria-label="Search users by name or email"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full pl-9 pr-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>
          <div className="flex gap-3">
            <select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <select
              aria-label="Filter by status"
              value={bannedFilter}
              onChange={(e) => {
                setBannedFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              <option value="">All status</option>
              <option value="false">Active</option>
              <option value="true">Banned</option>
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
      </div>

      {error && data.users.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading users…" />
      ) : data.users.length === 0 && error ? (
        <RetryCard message={error} onRetry={refresh} />
      ) : data.users.length === 0 ? (
        <div className="content-card">
          <EmptyState
            illustration="default"
            title={hasFilters ? 'No matching users' : 'No users yet'}
            description={
              hasFilters
                ? 'Try adjusting your search or filters.'
                : 'Registered users will appear here.'
            }
          />
        </div>
      ) : (
        <div className="content-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Wallet</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Created</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => {
                  const self = isSelf(u);
                  const roleChanging = roleBusyId === u._id;
                  return (
                    <tr
                      key={u._id}
                      className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400/20 to-cyan-400/10 flex items-center justify-center text-emerald-400 font-semibold text-sm flex-shrink-0">
                            {(u.name || '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-slate-200 truncate flex items-center gap-1.5">
                              {u.name || 'Unnamed'}
                              {self && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 font-medium">
                                  You
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 truncate">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {mutate && !self ? (
                          <div className="relative inline-flex items-center">
                            <select
                              aria-label={`Change role for ${u.name || u.email}`}
                              value={u.role}
                              onChange={(e) => requestRoleChange(u, e.target.value)}
                              disabled={roleChanging}
                              className="appearance-none pl-2.5 pr-7 py-1.5 bg-slate-950 border border-slate-700/60 rounded-md text-xs text-white font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-50"
                            >
                              {ROLE_OPTIONS.map((r) => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                            {roleChanging && (
                              <Loader2 size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 animate-spin pointer-events-none" />
                            )}
                          </div>
                        ) : (
                          <RoleBadge role={u.role} />
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {u.walletAddress ? (
                          <button
                            type="button"
                            onClick={() => copyWallet(u)}
                            className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-400 hover:text-slate-200 transition-colors group"
                            title="Copy wallet address"
                          >
                            {shortWallet(u.walletAddress)}
                            {copiedId === u._id ? (
                              <Check size={12} className="text-emerald-400" />
                            ) : (
                              <Copy size={12} className="opacity-0 group-hover:opacity-100" />
                            )}
                          </button>
                        ) : (
                          <span className="font-mono text-xs text-slate-600">{shortWallet(null)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {u.isBanned ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[11px] font-semibold"
                            title={u.bannedReason || 'Banned'}
                          >
                            <Ban size={11} /> Banned
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold">
                            <ShieldCheck size={11} /> Active
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-400 text-xs">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        {mutate ? (
                          <div className="flex items-center justify-end gap-1.5">
                            {u.isBanned ? (
                              <button
                                type="button"
                                onClick={() => setUnbanTarget(u)}
                                disabled={self}
                                className="px-2.5 py-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title={self ? 'You cannot unban yourself' : 'Unban user'}
                              >
                                Unban
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setBanTarget(u)}
                                disabled={self}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title={self ? 'You cannot ban yourself' : 'Ban user'}
                              >
                                <Ban size={13} /> Ban
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(u)}
                              disabled={self}
                              className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={self ? 'You cannot deactivate yourself' : 'Deactivate user'}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ) : (
                          <span className="block text-right text-xs text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={meta.page}
            pages={meta.pages}
            total={meta.total}
            loading={loading}
            onChange={setPage}
          />
        </div>
      )}

      <BanUserModal
        open={!!banTarget}
        user={banTarget}
        loading={banLoading}
        onClose={() => setBanTarget(null)}
        onConfirm={handleBanConfirm}
      />

      <ConfirmDialog
        open={!!roleTarget}
        title="Change role"
        tone="default"
        message={
          roleTarget
            ? `Change ${roleTarget.user.name}'s role from "${roleTarget.user.role}" to "${roleTarget.nextRole}"?`
            : ''
        }
        confirmLabel="Change role"
        loading={!!roleTarget && roleBusyId === roleTarget.user._id}
        onClose={() => setRoleTarget(null)}
        onConfirm={handleRoleConfirm}
      />

      <ConfirmDialog
        open={!!unbanTarget}
        title="Unban user"
        tone="default"
        message={
          unbanTarget
            ? `Restore access for ${unbanTarget.name} (${unbanTarget.email})? They will be able to sign in again.`
            : ''
        }
        confirmLabel="Unban"
        loading={unbanLoading}
        onClose={() => setUnbanTarget(null)}
        onConfirm={handleUnbanConfirm}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Deactivate user"
        tone="danger"
        message={
          deleteTarget
            ? `Deactivate ${deleteTarget.name} (${deleteTarget.email})? This soft-deletes the account. The user will no longer be able to sign in.`
            : ''
        }
        confirmLabel="Deactivate"
        loading={deleteLoading}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
};

export default Users;
