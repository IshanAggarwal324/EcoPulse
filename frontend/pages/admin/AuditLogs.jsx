import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  AlertCircle,
  ScrollText,
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Loader2,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import EmptyState from '../../components/ui/EmptyState';
import PageLoader from '../../components/ui/PageLoader';
import Pagination from '../../components/admin/Pagination';
import RetryCard from '../../components/admin/RetryCard';
import { StatusPill, formatDateTime, shortWallet } from '../../utils/adminFormat';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';

const LIMIT = 25;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const MAX_METADATA_CHARS = 4000;

const SEVERITY_OPTIONS = ['info', 'warn', 'critical'];

// Mirrors VALID_RESOURCE_TYPES in backend/models/AuditLog.js.
const RESOURCE_TYPE_OPTIONS = [
  'api', 'auth', 'auto_trading', 'buyOrder', 'device', 'dispute', 'grid_zone', 'ingestion',
  'listing_intent', 'node', 'notification', 'public_grid', 'report_job', 'settlement',
  'simulator', 'sync', 'trade', 'user',
];

// Suggestions only: the filter accepts any action name (comma-separated for several).
const KNOWN_ACTIONS = [
  'AUTH_FAILED', 'USER_BANNED', 'USER_UNBANNED', 'USER_DELETED', 'USER_ROLE_CHANGED',
  'EMAIL_VERIFIED', 'WALLET_LINKED', 'WALLET_UNLINKED', 'NODE_CREATED', 'NODE_UPDATED',
  'NODE_DELETED', 'TRADE_SYNCED', 'SYNC_FORCED', 'REPORT_GENERATED', 'REPORT_RETRIED',
  'SIMULATOR_CONFIG_UPDATED', 'SIMULATOR_CONFIG_RESET', 'SIMULATOR_RESTARTED',
  'INGESTION_BACKFILL', 'DEVICE_PROVISIONED', 'DEVICE_UPDATED', 'DEVICE_KEY_ROTATED',
  'DEVICE_DELETED', 'MARKETPLACE_PAUSED', 'MARKETPLACE_RESUMED', 'AUTO_POLICY_CREATED',
  'AUTO_POLICY_UPDATED', 'AUTO_POLICY_DELETED', 'AUTO_TRADING_PAUSED', 'AUTO_TRADING_RESUMED',
  'BUY_ORDER_CREATED', 'BUY_ORDER_CANCELLED', 'DISPUTE_RESOLVED', 'API_RATE_LIMITED',
];

const startOfDayIso = (dateStr) => {
  if (!dateStr) return undefined;
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

const endOfDayIso = (dateStr) => {
  if (!dateStr) return undefined;
  const d = new Date(`${dateStr}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

const formatMetadata = (metadata) => {
  if (metadata === null || metadata === undefined) return null;
  let text;
  try {
    text = JSON.stringify(metadata, null, 2);
  } catch {
    text = String(metadata);
  }
  if (text.length > MAX_METADATA_CHARS) {
    return `${text.slice(0, MAX_METADATA_CHARS)}\n… (truncated, ${text.length - MAX_METADATA_CHARS} more characters)`;
  }
  return text;
};

const DetailRow = ({ label, value, mono = false, copyable = false, copied, onCopy }) => {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5">{label}</p>
      <div className="flex items-center gap-1.5">
        <p className={`text-xs text-slate-200 break-all ${mono ? 'font-mono' : ''}`}>{value}</p>
        {copyable && (
          <button
            type="button"
            onClick={() => onCopy(value)}
            className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
            title={`Copy ${label.toLowerCase()}`}
            aria-label={`Copy ${label.toLowerCase()}`}
          >
            {copied === value ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          </button>
        )}
      </div>
    </div>
  );
};

const AuditLogs = () => {
  const toast = useToast();

  const [data, setData] = useState({ logs: [], meta: { page: 1, limit: LIMIT, total: 0, pages: 1 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);

  // Filters. Text inputs are debounced into their "applied" counterparts.
  const [severity, setSeverity] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [actorId, setActorId] = useState('');
  const [resourceIdInput, setResourceIdInput] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');

  const [expanded, setExpanded] = useState(() => new Set());
  const [copied, setCopied] = useState('');

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyError, setVerifyError] = useState('');

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      setAction(actionInput.trim());
      setActorId(actorInput.trim());
      setResourceId(resourceIdInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [actionInput, actorInput, resourceIdInput]);

  const actorInvalid = Boolean(actorId) && !OBJECT_ID_RE.test(actorId);
  const rangeInvalid = Boolean(sinceDate && untilDate && sinceDate > untilDate);
  // Invalid filter input is reported next to the field and never sent to the API.
  const blocked = actorInvalid || rangeInvalid;

  useEffect(() => {
    if (blocked) return undefined;
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const params = { page, limit: LIMIT };
        if (severity) params.severity = severity;
        if (resourceType) params.resourceType = resourceType;
        if (action) params.action = action;
        if (actorId) params.actorId = actorId;
        if (resourceId) params.resourceId = resourceId;
        const since = startOfDayIso(sinceDate);
        const until = endOfDayIso(untilDate);
        if (since) params.since = since;
        if (until) params.until = until;

        const res = await adminApi.listAuditLogs(params);
        if (!active) return;
        const pages = res.meta?.pages || 1;
        setData({
          logs: res.data || [],
          meta: res.meta || { page, limit: LIMIT, total: 0, pages: 1 },
        });
        setExpanded(new Set());
        if (page > pages) setPage(Math.max(1, pages));
      } catch (err) {
        if (!active) return;
        setError(err.message || 'Failed to load audit logs');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, severity, resourceType, action, actorId, resourceId, sinceDate, untilDate, blocked, reloadKey]);

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      toast.success('Copied');
      setTimeout(() => setCopied(''), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  const toggleRow = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runVerify = async () => {
    setVerifying(true);
    setVerifyError('');
    setVerifyResult(null);
    try {
      const res = await adminApi.verifyAuditLogs();
      setVerifyResult(res.data || { totalChecked: 0, brokenCount: 0, broken: [] });
    } catch (err) {
      setVerifyError(err.message || 'Integrity check failed');
    } finally {
      setVerifying(false);
    }
  };

  const hasFilters = Boolean(
    severity || resourceType || actionInput || actorInput || resourceIdInput || sinceDate || untilDate,
  );

  const clearFilters = () => {
    setSeverity('');
    setResourceType('');
    setActionInput('');
    setAction('');
    setActorInput('');
    setActorId('');
    setResourceIdInput('');
    setResourceId('');
    setSinceDate('');
    setUntilDate('');
    setPage(1);
  };

  const inputClass =
    'w-full px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
  const meta = data.meta || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Audit Logs"
        subtitle="Immutable operational trail"
        action={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-400 text-xs font-medium">
              <ScrollText size={14} />
              {meta.total ?? 0} entries
            </span>
            <button
              type="button"
              onClick={runVerify}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-60 text-xs font-semibold transition-colors"
            >
              {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Verify integrity
            </button>
          </div>
        }
      />

      {verifyError && (
        <div role="alert" className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {verifyError}
        </div>
      )}

      {verifyResult && (
        <div
          role="status"
          className={`p-3 rounded-xl mb-4 border text-sm ${
            verifyResult.brokenCount === 0
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          <div className="flex items-start gap-2">
            {verifyResult.brokenCount === 0 ? (
              <ShieldCheck size={16} className="flex-shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert size={16} className="flex-shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              {verifyResult.brokenCount === 0 ? (
                <p>
                  Chain intact — checked {verifyResult.totalChecked} of the oldest retained entries and found no
                  tampering.
                </p>
              ) : (
                <>
                  <p>
                    {verifyResult.brokenCount} problem{verifyResult.brokenCount === 1 ? '' : 's'} found in{' '}
                    {verifyResult.totalChecked} checked entries. Entries may have been altered or removed.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs font-mono">
                    {(verifyResult.broken || []).slice(0, 10).map((b) => (
                      <li key={`${b.id}-${b.reason}`}>
                        {b.action} · {b.reason} · {shortWallet(String(b.id))}
                      </li>
                    ))}
                  </ul>
                  {verifyResult.broken && verifyResult.broken.length > 10 && (
                    <p className="mt-1 text-xs">…and {verifyResult.broken.length - 10} more.</p>
                  )}
                </>
              )}
              <p className="mt-1.5 text-xs opacity-70">
                Each entry is hash-linked to the one before it. Older entries expire automatically (90 days by
                default), so only the retained history is checked.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="content-card mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <select
            aria-label="Filter by severity"
            value={severity}
            onChange={(e) => { setSeverity(e.target.value); setPage(1); }}
            className={inputClass}
          >
            <option value="">All severities</option>
            {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            aria-label="Filter by resource type"
            value={resourceType}
            onChange={(e) => { setResourceType(e.target.value); setPage(1); }}
            className={inputClass}
          >
            <option value="">All resource types</option>
            {RESOURCE_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              list="audit-action-suggestions"
              aria-label="Filter by action"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              placeholder="Action, e.g. USER_BANNED"
              className={`${inputClass} pl-9 font-mono`}
            />
            <datalist id="audit-action-suggestions">
              {KNOWN_ACTIONS.map((a) => <option key={a} value={a} />)}
            </datalist>
          </div>

          <div>
            <input
              type="text"
              aria-label="Filter by actor ID"
              value={actorInput}
              onChange={(e) => setActorInput(e.target.value)}
              placeholder="Actor user ID (24 characters)"
              className={`${inputClass} font-mono ${actorInvalid ? 'border-rose-500/60' : ''}`}
              aria-invalid={actorInvalid}
            />
            {actorInvalid && (
              <p className="text-[11px] text-rose-300 mt-1">An actor ID is 24 hexadecimal characters.</p>
            )}
          </div>

          <input
            type="text"
            aria-label="Filter by resource ID"
            value={resourceIdInput}
            onChange={(e) => setResourceIdInput(e.target.value)}
            placeholder="Resource ID"
            className={`${inputClass} font-mono`}
          />

          <label className="text-[11px] text-slate-500">
            From
            <input
              type="date"
              aria-label="From date"
              value={sinceDate}
              max={untilDate || undefined}
              onChange={(e) => { setSinceDate(e.target.value); setPage(1); }}
              className={`${inputClass} mt-1`}
            />
          </label>

          <label className="text-[11px] text-slate-500">
            To
            <input
              type="date"
              aria-label="To date"
              value={untilDate}
              min={sinceDate || undefined}
              onChange={(e) => { setUntilDate(e.target.value); setPage(1); }}
              className={`${inputClass} mt-1`}
            />
            {rangeInvalid && (
              <span className="block text-[11px] text-rose-300 mt-1">“From” must not be after “To”.</span>
            )}
          </label>

          {hasFilters && (
            <div className="flex items-end">
              <button
                type="button"
                onClick={clearFilters}
                className="w-full px-3 py-2.5 text-sm font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>

      {error && data.logs.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !blocked ? (
        <PageLoader message="Loading audit logs…" />
      ) : data.logs.length === 0 && error ? (
        <RetryCard message={error} onRetry={refresh} />
      ) : data.logs.length === 0 ? (
        <div className="content-card">
          <EmptyState
            title={hasFilters ? 'No matching entries' : 'No audit entries yet'}
            description={
              hasFilters
                ? 'Try adjusting or clearing your filters.'
                : 'Admin actions and key user events will be recorded here.'
            }
          />
        </div>
      ) : (
        <div className="content-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-3 py-3 w-8"><span className="sr-only">Details</span></th>
                  <th className="px-3 py-3 font-semibold">Time</th>
                  <th className="px-3 py-3 font-semibold">Severity</th>
                  <th className="px-3 py-3 font-semibold">Action</th>
                  <th className="px-3 py-3 font-semibold hidden md:table-cell">Actor</th>
                  <th className="px-3 py-3 font-semibold hidden lg:table-cell">Resource</th>
                  <th className="px-3 py-3 font-semibold hidden xl:table-cell">IP</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => {
                  const isOpen = expanded.has(log._id);
                  const metadataText = formatMetadata(log.metadata);
                  return (
                    <React.Fragment key={log._id}>
                      <tr className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                        <td className="px-3 py-3">
                          <button
                            type="button"
                            onClick={() => toggleRow(log._id)}
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${log.action}`}
                            className="text-slate-500 hover:text-slate-200 transition-colors"
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="px-3 py-3 text-slate-400 text-xs whitespace-nowrap" title={log.createdAt || undefined}>
                          {formatDateTime(log.createdAt)}
                        </td>
                        <td className="px-3 py-3"><StatusPill value={log.severity} /></td>
                        <td className="px-3 py-3 font-mono text-xs text-slate-200">{log.action}</td>
                        <td className="px-3 py-3 hidden md:table-cell">
                          {log.actorEmail ? (
                            <>
                              <p className="text-slate-200 text-xs">{log.actorEmail}</p>
                              {log.actorRole && <p className="text-slate-500 text-[11px]">{log.actorRole}</p>}
                            </>
                          ) : (
                            <span className="text-slate-500 text-xs">system / anonymous</span>
                          )}
                        </td>
                        <td className="px-3 py-3 hidden lg:table-cell">
                          <p className="text-slate-300 text-xs">{log.resourceType}</p>
                          {log.resourceId && (
                            <p className="text-slate-500 text-[11px] font-mono" title={log.resourceId}>
                              {shortWallet(log.resourceId)}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3 hidden xl:table-cell text-slate-500 text-xs font-mono">{log.ip || '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-slate-800/50 bg-slate-900/40">
                          <td />
                          <td colSpan={6} className="px-3 py-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                              <DetailRow label="Entry ID" value={log._id} mono copyable copied={copied} onCopy={copyText} />
                              <DetailRow label="Actor ID" value={log.actorId} mono copyable copied={copied} onCopy={copyText} />
                              <DetailRow label="Resource ID" value={log.resourceId} mono copyable copied={copied} onCopy={copyText} />
                              <DetailRow label="IP address" value={log.ip} mono />
                              <DetailRow label="User agent" value={log.userAgent} />
                              <DetailRow label="Recorded at" value={log.createdAt} mono />
                            </div>
                            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Metadata</p>
                            {metadataText ? (
                              <pre className="text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
                                {metadataText}
                              </pre>
                            ) : (
                              <p className="text-xs text-slate-600">None recorded.</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} loading={loading} onChange={setPage} />
        </div>
      )}
    </div>
  );
};

export default AuditLogs;
