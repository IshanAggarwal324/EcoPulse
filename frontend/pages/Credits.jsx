import React, { useState, useEffect } from 'react';
import { Award, RefreshCw, TrendingUp, Zap, AlertCircle } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import { analyticsApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import PageLoader from '../components/ui/PageLoader';

const Credits = () => {
  const [carbon, setCarbon] = useState(null);
  const [trades, setTrades] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  const loadCredits = async () => {
    try {
      setError(null);
      const res = await analyticsApi.getSummary();
      setCarbon(res.data.carbon);
      setTrades(res.data.trades);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load carbon statistics');
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      setError(null);
      const res = await analyticsApi.syncBlockchain();
      setCarbon(res.data.summary.carbon);
      setTrades(res.data.summary.trades);
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
    loadCredits();
  }, []);

  const cards = [
    {
      label: 'Credits Traded',
      value: (carbon?.totalCreditsTraded || 0).toFixed(2),
      icon: <TrendingUp size={24} className="text-emerald-400" />,
      trend: 'On-chain volume',
      positive: true,
    },
    {
      label: 'Completed Trades',
      value: (trades?.completedTrades || 0).toLocaleString(),
      icon: <Zap size={24} className="text-blue-400" />,
      trend: `${trades?.totalEnergyTraded || 0} kWh`,
      positive: true,
    },
    {
      label: 'Grid Credit Estimate',
      value: (carbon?.estimatedGridCredits || 0).toLocaleString(),
      icon: <Award size={24} className="text-yellow-400" />,
      trend: 'Platform aggregate',
      positive: true,
    },
  ];

  return (
    <div className="space-y-8 pb-8">
      <SectionTitle
        title="Carbon Credits"
        subtitle="Blockchain-synced carbon credit statistics and trade volume."
        action={
          <button
            onClick={handleSync}
            disabled={syncing}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium rounded-lg transition-colors w-full sm:w-auto"
          >
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Blockchain'}
          </button>
        }
      />

      {error && (
        <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading carbon credit analytics..." />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {cards.map((card, idx) => (
              <SummaryCard key={idx} {...card} />
            ))}
          </div>

          <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
            <h3 className="text-lg font-bold text-white mb-4">Credit Ledger Summary</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <dt className="text-slate-400">Total listings indexed</dt>
                <dd className="text-2xl font-bold text-white mt-1">{trades?.totalListings || 0}</dd>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <dt className="text-slate-400">Credits traded (CC)</dt>
                <dd className="text-2xl font-bold text-emerald-400 mt-1">
                  {(carbon?.totalCreditsTraded || 0).toFixed(4)}
                </dd>
              </div>
            </dl>
            <p className="text-slate-500 text-sm mt-4">
              Connect a wallet on the Dashboard to include your live on-chain balance in analytics.
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default Credits;
