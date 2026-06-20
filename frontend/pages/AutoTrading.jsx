import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { autoTradingApi, notificationApi, nodesApi } from '../utils/api';
import { getProvider, EXPECTED_CHAIN_ID } from '../utils/blockchain';
import { useWallet } from '../context/WalletContext';
import { useToast } from '../context/ToastContext';
import { useSocketEvent } from '../context/SocketContext';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import SectionTitle from '../components/ui/SectionTitle';
import EmptyState from '../components/ui/EmptyState';
import { Bot, Loader2, ShieldAlert, Bell, Check, X, Zap } from 'lucide-react';

const MICRO_CC_SCALE = 1_000_000n;
const floor = (n) => Math.max(0, Math.floor(Number(n) || 0));
const toMicroCc = (cc) => {
  if (cc === null || cc === undefined || cc === '') return 0n;
  return BigInt(Math.max(0, Math.round(Number(cc) * Number(MICRO_CC_SCALE))));
};

const formatDate = (value) => (value ? new Date(value).toLocaleString() : '—');

const AutoTrading = () => {
  const [nodes, setNodes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // policyId or 'create' while working

  const { account, connect, reconnect, hadPreviousSession, isCorrectNetwork, ensureNetwork } = useWallet();
  const toast = useToast();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [nodesRes, policiesRes, notifRes] = await Promise.all([
        nodesApi.getAll().catch(() => ({ data: [] })),
        autoTradingApi.listPolicies().catch(() => ({ data: [] })),
        notificationApi.list({ limit: 25 }).catch(() => ({ data: [] })),
      ]);
      setNodes(nodesRes.data || []);
      setPolicies(policiesRes.data || []);
      setNotifications(notifRes.data?.data || []);
      setUnreadCount(notifRes.data?.meta?.unread || 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Live notifications via socket (user-scoped room).
  useSocketEvent(SOCKET_EVENTS.SERVER.NOTIFICATION, useCallback(() => {
    notificationApi.list({ limit: 25 }).then((res) => {
      setNotifications(res.data?.data || []);
      setUnreadCount(res.data?.meta?.unread || 0);
    }).catch(() => {});
    toast.info('New listing opportunity notification');
  }, [toast]));

  const requireWallet = async () => {
    if (account) return true;
    toast.info(hadPreviousSession ? 'Reconnect your wallet to continue' : 'Connect your wallet to continue');
    try {
      if (hadPreviousSession) await reconnect();
      else await connect();
      return true;
    } catch (err) {
      toast.error(err.message || 'Wallet connection required');
      return false;
    }
  };

  const handleCreate = async (nodeId) => {
    setBusy('create');
    try {
      await autoTradingApi.createPolicy({ nodeId });
      toast.success('Policy created (disabled). Sign to enable auto-listing.');
      await loadAll();
    } catch (err) {
      toast.error(err.message || 'Failed to create policy');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (policyId) => {
    if (!window.confirm('Delete this auto-trading policy? This revokes any signed authorization.')) return;
    setBusy(policyId);
    try {
      await autoTradingApi.deletePolicy(policyId);
      toast.success('Policy deleted');
      await loadAll();
    } catch (err) {
      toast.error(err.message || 'Failed to delete policy');
    } finally {
      setBusy(null);
    }
  };

  const handleDisable = async (policyId) => {
    setBusy(policyId);
    try {
      await autoTradingApi.disablePolicy(policyId);
      toast.success('Auto-listing disabled');
      await loadAll();
    } catch (err) {
      toast.error(err.message || 'Failed to disable');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Enable flow: fetch the canonical EIP-712 domain from the backend, build the
   * message with the SAME encoding the backend will re-derive, sign it in
   * MetaMask, then POST the signature + declared bounds. The backend verifies
   * the signer matches the wallet — nothing secret leaves the browser.
   */
  const handleEnable = async (policy) => {
    if (!(await requireWallet()) || !isCorrectNetwork) {
      if (isCorrectNetwork === false) {
        toast.info('Switch to the expected network in MetaMask');
        try { await ensureNetwork(); } catch (e) { toast.error(e.message); return; }
      }
    }
    setBusy(policy.id);
    try {
      const { data } = await autoTradingApi.getEip712Domain();
      const { domain, types, suggested } = data;

      // Bounds prefilled from policy defaults. Editable in a real product; here
      // we cap energy at the policy's horizon-derived surplus ceiling.
      const maxEnergyKwh = floor(window.prompt('Max energy per auto-list (kWh, whole units)?', '100') ?? 100);
      const maxTotalCc = floor(window.prompt('Max total CC per auto-list?', String(policy.maxTotalCcPerDay || 1000)) ?? 1000);

      const message = {
        policyId: String(policy.id),
        maxEnergyKwh: BigInt(maxEnergyKwh),
        minUnitPriceMicroCc: policy.minUnitPriceCc != null ? toMicroCc(policy.minUnitPriceCc) : 0n,
        maxUnitPriceMicroCc: policy.maxUnitPriceCc != null ? toMicroCc(policy.maxUnitPriceCc) : 0n,
        maxTotalCc: BigInt(maxTotalCc),
        expiresAt: BigInt(suggested.expiresAtUnix),
        nonce: BigInt(suggested.nonce),
      };

      const provider = getProvider();
      if (!provider) throw new Error('No wallet provider');
      const signer = await provider.getSigner();
      toast.info('Sign the listing authorization in MetaMask...');
      const signature = await signer.signTypedData(domain, types, message);

      await autoTradingApi.enablePolicy(policy.id, {
        signature,
        maxEnergyKwh,
        minUnitPriceCc: policy.minUnitPriceCc ?? null,
        maxUnitPriceCc: policy.maxUnitPriceCc ?? null,
        maxTotalCc,
        expiresAtUnix: suggested.expiresAtUnix,
        nonce: suggested.nonce,
      });

      toast.success('Auto-listing enabled. You will be notified of opportunities.');
      await loadAll();
    } catch (err) {
      if (err?.code === 4001 || /user rejected/i.test(err?.message || '')) {
        toast.info('Signing cancelled');
      } else {
        toast.error(err.message || 'Failed to enable auto-listing');
      }
    } finally {
      setBusy(null);
    }
  };

  const markAllRead = async () => {
    try {
      await notificationApi.markAllRead();
      await loadAll();
    } catch (err) {
      toast.error(err.message || 'Failed to mark notifications read');
    }
  };

  const policyForNode = (nodeId) => policies.find((p) => p.nodeId === nodeId);

  return (
    <div className="page-section">
      <SectionTitle
        title="Auto-Trading"
        subtitle="Opt in to automatic listing recommendations driven by your forecast surplus."
      />

      {/* Consent / disclaimer copy (guardrail 2.3: clear consent) */}
      <div className="content-card mb-5 border-l-4 border-emerald-500/60">
        <div className="flex items-start gap-3">
          <ShieldAlert size={22} className="text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300 space-y-2">
            <p className="font-semibold text-white">How this works &amp; your controls</p>
            <ul className="list-disc pl-5 space-y-1 text-slate-400">
              <li><span className="text-slate-200">Opt-in only.</span> Disabled by default. Enabling requires a wallet signature authorizing bounded listings.</li>
              <li><span className="text-slate-200">Notify-only.</span> EcoPulse never holds your private keys. When an opportunity is found you get a notification and confirm the real listing in MetaMask.</li>
              <li><span className="text-slate-200">Bounded.</span> Your signed intent caps energy, unit price and total CC per decision, and expires in 24h.</li>
              <li><span className="text-slate-200">Recommendations are not guarantees.</span> The on-chain marketplace contract is the source of truth for executed prices.</li>
            </ul>
          </div>
        </div>
      </div>

      {!account && (
        <div className="content-card mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-slate-400 text-sm">Connect your wallet to enable auto-listing for a node.</p>
          <button
            type="button"
            onClick={() => (hadPreviousSession ? reconnect() : connect()).catch((e) => toast.error(e.message))}
            className="touch-target shrink-0 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white font-medium px-4 py-2 rounded-xl"
          >
            Connect Wallet
          </button>
        </div>
      )}

      {/* Policies per node */}
      <div className="content-card mb-5">
        <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <Bot size={20} className="text-emerald-400" /> Node policies
        </h3>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-slate-400 gap-2">
            <Loader2 size={20} className="animate-spin" /> Loading...
          </div>
        ) : nodes.length === 0 ? (
          <EmptyState illustration="trading" title="No nodes" description="Create a node first to set up auto-trading." />
        ) : (
          <div className="space-y-3">
            {nodes.map((node) => {
              const policy = policyForNode(node._id);
              return (
                <div key={node._id} className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-white font-semibold truncate">{node.name}</p>
                      <p className="text-xs text-slate-500">
                        {node.nodeType} · {node.status}
                      </p>
                    </div>
                    {policy ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-xs px-2.5 py-1 rounded-lg font-medium ${
                            policy.enabled
                              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                              : 'bg-slate-700/40 text-slate-400 border border-slate-600/40'
                          }`}
                        >
                          {policy.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="text-xs text-slate-500">{policy.priceStrategy}</span>
                        {policy.enabled ? (
                          <button
                            type="button"
                            onClick={() => handleDisable(policy.id)}
                            disabled={busy === policy.id}
                            className="touch-target text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-50"
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleEnable(policy)}
                            disabled={busy === policy.id || !account}
                            className="touch-target text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                          >
                            {busy === policy.id ? 'Signing...' : 'Enable'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(policy.id)}
                          disabled={busy === policy.id}
                          className="touch-target text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-700/40 text-slate-300 border border-slate-600/40 hover:bg-slate-700/60 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCreate(node._id)}
                        disabled={busy === 'create'}
                        className="touch-target text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                      >
                        {busy === 'create' ? 'Creating...' : 'Create policy'}
                      </button>
                    )}
                  </div>

                  {policy && (
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-slate-400">
                      <span>Min surplus: <span className="text-slate-200 font-mono">{policy.minSurplusKwh} kWh</span></span>
                      <span>Max/day: <span className="text-slate-200 font-mono">{policy.maxListingsPerDay}</span></span>
                      <span>CC cap/day: <span className="text-slate-200 font-mono">{policy.maxTotalCcPerDay}</span></span>
                      <span>Discount: <span className="text-slate-200 font-mono">{policy.fixedDiscountPercent}%</span></span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Notifications feed */}
      <div className="content-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Bell size={20} className="text-emerald-400" /> Notifications
            {unreadCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">{unreadCount} new</span>
            )}
          </h3>
          {unreadCount > 0 && (
            <button type="button" onClick={markAllRead} className="touch-target text-xs text-emerald-400 hover:text-emerald-300">
              Mark all read
            </button>
          )}
        </div>

        {notifications.length === 0 ? (
          <EmptyState illustration="transactions" title="No notifications yet" description="Enable auto-trading to receive listing opportunities here." />
        ) : (
          <div className="space-y-2">
            {notifications.map((n) => {
              const isRecommendation = n.type === 'auto_listing_recommendation';
              const isStale = n.type === 'auto_listing_stale';
              return (
                <div
                  key={n._id}
                  className={`rounded-lg border p-3 ${
                    n.readAt ? 'border-slate-700/40 bg-slate-900/20' : 'border-emerald-500/30 bg-emerald-500/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {isRecommendation ? (
                          <Zap size={14} className="text-emerald-400 shrink-0" />
                        ) : isStale ? (
                          <ShieldAlert size={14} className="text-amber-400 shrink-0" />
                        ) : (
                          <Bell size={14} className="text-slate-400 shrink-0" />
                        )}
                        <p className="text-sm font-semibold text-white truncate">{n.title}</p>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{n.body}</p>
                      {isRecommendation && n.data && (
                        <div className="mt-2 text-xs text-slate-500">
                          Suggested: <span className="text-slate-300 font-mono">{n.data.energyAmount} units</span> @{' '}
                          <span className="text-slate-300 font-mono">{n.data.unitPriceCc} CC/unit</span> · confirm in the Trading page.
                        </div>
                      )}
                      <p className="text-[11px] text-slate-600 mt-1">{formatDate(n.createdAt)}</p>
                    </div>
                    {n.readAt ? (
                      <Check size={14} className="text-slate-600 shrink-0" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 mt-1.5" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AutoTrading;
