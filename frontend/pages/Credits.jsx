import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Award,
  RefreshCw,
  TrendingUp,
  Zap,
  AlertCircle,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Users,
} from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import CarbonBalanceChart from '../components/ui/CarbonBalanceChart';
import { analyticsApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import PageLoader from '../components/ui/PageLoader';

const PERIOD_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const parseAmount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const Credits = () => {
  const [carbon, setCarbon] = useState(null);
  const [trades, setTrades] = useState(null);
  const [balanceAnalytics, setBalanceAnalytics] = useState(null);
  const [periodDays, setPeriodDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const { account, balance: liveBalance, refreshBalance } = useWallet();
  const toast = useToast();

  const loadCredits = useCallback(async () => {
    try {
      setError(null);
      const params = { days: String(periodDays) };
      if (account) params.wallet = account;

      const [summaryRes, balanceRes] = await Promise.all([
        analyticsApi.getSummary(account ? { wallet: account } : {}),
        analyticsApi.getCarbonBalance(params),
      ]);

      setCarbon(summaryRes.data.carbon);
      setTrades(summaryRes.data.trades);
      setBalanceAnalytics(balanceRes.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load carbon statistics');
    } finally {
      setLoading(false);
    }
  }, [account, periodDays]);

  const handleSync = async () => {
    try {
      setSyncing(true);
      setError(null);
      const res = await analyticsApi.syncBlockchain();
      setCarbon(res.data.summary.carbon);
      setTrades(res.data.summary.trades);
      setBalanceAnalytics(res.data.summary.carbon?.balanceAnalytics || null);
      await refreshBalance();
      await loadCredits();
      toast.success('Blockchain data synced');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Blockchain sync failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadCredits();
  }, [loadCredits]);

  const wallet = balanceAnalytics?.wallet;
  const platform = balanceAnalytics?.platform;
  const displayBalance = wallet?.balance ?? liveBalance ?? carbon?.walletBalance;

  const walletCards = account
    ? [
        {
          label: 'Wallet Balance',
          value: `${parseAmount(displayBalance).toFixed(2)} CC`,
          icon: <Wallet size={24} className="text-emerald-400" />,
          trend: 'On-chain balance',
          positive: true,
        },
        {
          label: 'Credits Received',
          value: `${(wallet?.creditsReceived || 0).toFixed(2)} CC`,
          icon: <ArrowDownLeft size={24} className="text-blue-400" />,
          trend: `${wallet?.saleCount || 0} sales`,
          positive: true,
        },
        {
          label: 'Credits Spent',
          value: `${(wallet?.creditsSpent || 0).toFixed(2)} CC`,
          icon: <ArrowUpRight size={24} className="text-rose-400" />,
          trend: `${wallet?.purchaseCount || 0} purchases`,
          positive: false,
        },
        {
          label: 'Net Flow',
          value: `${(wallet?.netFlow || 0).toFixed(2)} CC`,
          icon: <TrendingUp size={24} className="text-violet-400" />,
          trend: `Last ${periodDays} days`,
          positive: (wallet?.netFlow || 0) >= 0,
        },
      ]
    : [];

  const platformCards = [
    {
      label: 'Credits Traded',
      value: (platform?.totalCreditsTraded ?? carbon?.totalCreditsTraded ?? 0).toFixed(2),
      icon: <TrendingUp size={24} className="text-emerald-400" />,
      trend: 'On-chain volume',
      positive: true,
    },
    {
      label: 'Total Supply',
      value: platform?.totalSupply
        ? `${parseAmount(platform.totalSupply).toLocaleString(undefined, { maximumFractionDigits: 0 })} CC`
        : '—',
      icon: <Coins size={24} className="text-yellow-400" />,
      trend: 'ERC-20 circulating',
      positive: true,
    },
    {
      label: 'Active Traders',
      value: (platform?.uniqueTraders || 0).toLocaleString(),
      icon: <Users size={24} className="text-blue-400" />,
      trend: `${trades?.completedTrades || 0} completed trades`,
      positive: true,
    },
    {
      label: 'Grid Credit Estimate',
      value: (carbon?.estimatedGridCredits || 0).toLocaleString(),
      icon: <Award size={24} className="text-purple-400" />,
      trend: 'Platform aggregate',
      positive: true,
    },
  ];

  const cards = account ? walletCards : platformCards;

  return (
    <div className="space-y-8 pb-8">
      <SectionTitle
        title="Carbon Credits"
        subtitle="Balance analytics, credit flows, and platform-wide CC metrics synced from chain."
        action={
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium rounded-lg transition-colors w-full sm:w-auto"
          >
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Blockchain'}
          </button>
        }
      />

      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            onClick={() => setPeriodDays(option.days)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              periodDays === option.days
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-slate-800/60 text-slate-400 border border-slate-700/50 hover:text-slate-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {!account && (
        <div className="p-4 bg-slate-800/80 border border-slate-700/50 rounded-xl text-sm text-slate-300">
          Connect your wallet on the{' '}
          <Link to="/" className="text-emerald-400 hover:underline">
            Dashboard
          </Link>{' '}
          to see personal balance analytics, or view platform-wide metrics below.
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading carbon credit analytics..." />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {cards.map((card) => (
              <SummaryCard key={card.label} {...card} />
            ))}
          </div>

          {account && wallet && (
            <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
              <h3 className="text-lg font-bold text-white mb-4">Balance breakdown</h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Current balance</dt>
                  <dd className="text-2xl font-bold text-emerald-400 mt-1">
                    {parseAmount(displayBalance).toFixed(2)} CC
                  </dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Marketplace allowance</dt>
                  <dd className="text-2xl font-bold text-white mt-1">
                    {parseAmount(wallet.allowance).toFixed(2)} CC
                  </dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Unapproved balance</dt>
                  <dd className="text-2xl font-bold text-slate-200 mt-1">
                    {parseAmount(wallet.unapprovedBalance).toFixed(2)} CC
                  </dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Period net flow</dt>
                  <dd
                    className={`text-2xl font-bold mt-1 ${
                      (wallet.netFlow || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {(wallet.netFlow || 0) >= 0 ? '+' : ''}
                    {(wallet.netFlow || 0).toFixed(2)} CC
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
              <h3 className="text-lg font-bold text-white mb-1">
                {account ? 'Your credit flow' : 'Platform credit volume'}
              </h3>
              <p className="text-sm text-slate-400 mb-4">
                {account
                  ? 'Daily credits received vs spent, with cumulative net balance change.'
                  : 'Daily CC volume settled through marketplace purchases.'}
              </p>
              <CarbonBalanceChart
                mode={account ? 'wallet' : 'platform'}
                walletHistory={wallet?.history || []}
                platformVolume={platform?.volumeByDay || []}
              />
            </div>

            <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Zap size={20} className="text-emerald-400" />
                Credit ledger summary
              </h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Total listings indexed</dt>
                  <dd className="text-2xl font-bold text-white mt-1">{trades?.totalListings || 0}</dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Credits traded (CC)</dt>
                  <dd className="text-2xl font-bold text-emerald-400 mt-1">
                    {(platform?.totalCreditsTraded ?? carbon?.totalCreditsTraded ?? 0).toFixed(4)}
                  </dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Completed trades</dt>
                  <dd className="text-2xl font-bold text-white mt-1">
                    {platform?.completedTrades ?? trades?.completedTrades ?? 0}
                  </dd>
                </div>
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                  <dt className="text-slate-400">Energy traded</dt>
                  <dd className="text-2xl font-bold text-blue-400 mt-1">
                    {(trades?.totalEnergyTraded || 0).toLocaleString()} kWh
                  </dd>
                </div>
              </dl>
              <Link
                to="/transactions"
                className="inline-flex mt-4 text-sm text-emerald-400 hover:text-emerald-300 font-medium"
              >
                View transaction ledger →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Credits;
