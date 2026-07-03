import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet,
  RefreshCw,
  ArrowDownLeft,
  ArrowUpRight,
  TrendingUp,
  Award,
  AlertCircle,
  Send,
  Flame,
  Hourglass,
  ArrowRight,
} from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import PageLoader from '../components/ui/PageLoader';
import { analyticsApi, carbonApi, settlementsApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import { useSocketEvent } from '../context/SocketContext';
import { SOCKET_EVENTS } from '../constants/socketEvents';

const CarbonBalanceChart = lazy(() => import('../components/ui/CarbonBalanceChart'));

const PERIOD_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const fmtAddr = (addr) => {
  if (!addr || typeof addr !== 'string') return '—';
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
};

const LIFECYCLE_LABEL = {
  pending: 'Pending',
  on_chain_confirmed: 'On-chain confirmed',
  readings_verified: 'Readings verified',
  released: 'Released',
  mismatch: 'Delivery mismatch',
  disputed: 'Disputed',
  refunded: 'Refunded',
};

const CarbonWallet = () => {
  const toast = useToast();
  const { account, balance, connecting, isCorrectNetwork, expectedChainId, connect, refreshBalance } = useWallet();

  const [periodDays, setPeriodDays] = useState(30);
  const [balanceAnalytics, setBalanceAnalytics] = useState(null);
  const [carbonTotals, setCarbonTotals] = useState(null);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  const [reloadKey, setReloadKey] = useState(0);

  // Trigger a re-fetch from event handlers / socket events without calling
  // setState synchronously inside an effect (keeps the linter + React happy).
  const reload = useCallback((silent = false) => {
    setError(null);
    if (!silent) setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const me = account ? account.toLowerCase() : null;
    const params = { days: String(periodDays) };
    if (account) params.wallet = account;

    (async () => {
      try {
        const [balanceRes, totalsRes, pendingRes] = await Promise.all([
          analyticsApi.getCarbonBalance(params),
          carbonApi.getTotals().catch(() => null),
          me
            ? settlementsApi.listMine({ verificationStatus: 'pending', limit: 10 })
            : Promise.resolve({ data: [] }),
        ]);
        if (!active) return;
        setBalanceAnalytics(balanceRes.data);
        setCarbonTotals(totalsRes?.data || null);
        setPending(Array.isArray(pendingRes?.data) ? pendingRes.data : []);
      } catch (err) {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load wallet data');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [account, periodDays, reloadKey]);

  // Module 9.6 — silently refresh pending settlements when one resolves live.
  const onSettlementEvent = useCallback(() => reload(true), [reload]);
  useSocketEvent(SOCKET_EVENTS.SERVER.SETTLEMENT_VERIFIED, onSettlementEvent);
  useSocketEvent(SOCKET_EVENTS.SERVER.SETTLEMENT_MISMATCH, onSettlementEvent);

  const handleSync = async () => {
    try {
      setSyncing(true);
      setError(null);
      await refreshBalance();
      reload();
      toast.success('Wallet data refreshed');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Refresh failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSyncing(false);
    }
  };

  const walletAnalytics = balanceAnalytics?.wallet;
  const displayBalance = num(walletAnalytics?.balance ?? balance);

  const me = account ? account.toLowerCase() : null;

  const cards = useMemo(() => [
    {
      label: 'Wallet Balance',
      value: `${displayBalance.toFixed(2)} CC`,
      icon: <Wallet size={24} className="text-emerald-400" />,
      trend: 'On-chain balance',
      positive: true,
    },
    {
      label: 'Credits Received',
      value: `${num(walletAnalytics?.creditsReceived).toFixed(2)} CC`,
      icon: <ArrowDownLeft size={24} className="text-blue-400" />,
      trend: `${walletAnalytics?.saleCount || 0} sales`,
      positive: true,
    },
    {
      label: 'Credits Spent',
      value: `${num(walletAnalytics?.creditsSpent).toFixed(2)} CC`,
      icon: <ArrowUpRight size={24} className="text-rose-400" />,
      trend: `${walletAnalytics?.purchaseCount || 0} purchases`,
      positive: false,
    },
    {
      label: 'Net Flow',
      value: `${num(walletAnalytics?.netFlow).toFixed(2)} CC`,
      icon: <TrendingUp size={24} className="text-violet-400" />,
      trend: `Last ${periodDays} days`,
      positive: num(walletAnalytics?.netFlow) >= 0,
    },
    {
      label: 'Retired',
      value: carbonTotals?.totalRetired
        ? `${num(carbonTotals.totalRetired).toLocaleString(undefined, { maximumFractionDigits: 0 })} CC`
        : '—',
      icon: <Award size={24} className="text-amber-400" />,
      trend: carbonTotals?.totalRetirements != null ? `${carbonTotals.totalRetirements} retirements` : 'Permanently burned',
      positive: true,
    },
  ], [displayBalance, walletAnalytics, carbonTotals, periodDays]);

  return (
    <div className="page-section">
      <SectionTitle
        title="Carbon Wallet"
        subtitle="Your on-chain carbon-credit balance, flows, and pending settlements — unified."
        action={
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || !account}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-emerald-500/15 w-full sm:w-auto"
          >
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {/* Link-wallet CTA when not connected */}
      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-5 content-card rounded-xl">
          <div className="flex items-start gap-3">
            <Wallet size={22} className="text-emerald-400 mt-0.5" />
            <div>
              <p className="text-slate-200 font-medium">Connect your wallet</p>
              <p className="text-slate-500 text-sm">
                Link MetaMask to view your live carbon-credit balance, settlement status, and trading activity.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => connect().catch((e) => toast.error(e.message))}
            disabled={connecting}
            className="touch-target shrink-0 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-xl transition-all duration-200"
          >
            {connecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      )}

      {account && !isCorrectNetwork && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
          <AlertCircle size={20} className="text-amber-300 shrink-0" />
          <p className="text-amber-300 text-sm">
            Your wallet is on the wrong network (expected chain {expectedChainId}). Switch to view correct balances.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl">
          <AlertCircle size={20} className="text-rose-300 shrink-0" />
          <p className="text-rose-300 text-sm">{error}</p>
        </div>
      )}

      {loading && account ? (
        <PageLoader message="Loading wallet…" />
      ) : (
        <>
          {account && (
            <>
              <div className="flex flex-wrap gap-2">
                {PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.days}
                    type="button"
                    onClick={() => setPeriodDays(option.days)}
                    className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                      periodDays === option.days
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-slate-800/40 text-slate-500 border border-slate-700/30 hover:text-slate-200'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {cards.map((card) => (
                  <SummaryCard key={card.label} {...card} />
                ))}
              </div>

              <div className="content-card rounded-xl p-4 sm:p-6">
                <h3 className="text-slate-200 font-semibold mb-4">Balance history</h3>
                <Suspense fallback={<PageLoader message="Loading chart…" />}>
                  <CarbonBalanceChart
                    walletHistory={walletAnalytics?.history || []}
                    mode="wallet"
                  />
                </Suspense>
              </div>
            </>
          )}

          {/* Pending settlements */}
          {account && (
            <div className="content-card rounded-xl p-4 sm:p-6">
              <div className="flex items-center gap-2 mb-4">
                <Hourglass size={18} className="text-amber-400" />
                <h3 className="text-slate-200 font-semibold">Pending settlements</h3>
                <span className="ml-auto text-xs text-slate-500">{pending.length}</span>
              </div>

              {pending.length === 0 ? (
                <p className="text-slate-500 text-sm">No pending settlements. Deliveries are verified automatically.</p>
              ) : (
                <ul className="divide-y divide-slate-700/40">
                  {pending.map((s) => {
                    const role = me && s.seller === me ? 'Selling' : 'Buying';
                    const counterparty = me && s.seller === me ? s.buyer : s.seller;
                    const current = s?.lifecycle?.current || s.verificationStatus || 'pending';
                    return (
                      <li key={s._id || s.listingId} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-slate-400 text-sm w-20 shrink-0">{role}</span>
                        <span className="text-slate-200 text-sm font-mono">{fmtAddr(counterparty)}</span>
                        <span className="text-slate-500 text-sm">Listing #{s.listingId ?? '—'}</span>
                        <span className="text-slate-500 text-sm tabular-nums">
                          {num(s.onChainEnergy).toFixed(2)} kWh
                        </span>
                        <span className="ml-auto px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                          {LIFECYCLE_LABEL[current] || current}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Actions */}
          {account && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Link
                to="/transactions"
                className="content-card rounded-xl p-5 flex items-center gap-3 hover:border-emerald-500/40 transition-colors group"
              >
                <Send size={22} className="text-emerald-400" />
                <div>
                  <p className="text-slate-200 font-medium">Send / Retire credits</p>
                  <p className="text-slate-500 text-sm">Transfer or burn carbon credits on-chain.</p>
                </div>
                <ArrowRight size={18} className="ml-auto text-slate-600 group-hover:text-emerald-400 transition-colors" />
              </Link>
              <Link
                to="/transactions"
                className="content-card rounded-xl p-5 flex items-center gap-3 hover:border-emerald-500/40 transition-colors group"
              >
                <Flame size={22} className="text-rose-400" />
                <div>
                  <p className="text-slate-200 font-medium">Retirement history</p>
                  <p className="text-slate-500 text-sm">Review permanently burned credits.</p>
                </div>
                <ArrowRight size={18} className="ml-auto text-slate-600 group-hover:text-emerald-400 transition-colors" />
              </Link>
              <Link
                to="/credits"
                className="content-card rounded-xl p-5 flex items-center gap-3 hover:border-emerald-500/40 transition-colors group"
              >
                <Award size={22} className="text-amber-400" />
                <div>
                  <p className="text-slate-200 font-medium">Credit analytics</p>
                  <p className="text-slate-500 text-sm">Platform-wide CC metrics and supply.</p>
                </div>
                <ArrowRight size={18} className="ml-auto text-slate-600 group-hover:text-emerald-400 transition-colors" />
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CarbonWallet;
