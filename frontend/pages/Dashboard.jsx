import React, { useState, useEffect, useCallback } from 'react';
import { Zap, Activity, Award, Sun, Wind, Home, TrendingUp, AlertCircle } from 'lucide-react';
import io from 'socket.io-client';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import StatusCard from '../components/ui/StatusCard';
import WalletConnect from '../components/WalletConnect';
import BlockchainStatus from '../components/BlockchainStatus';
import { useWallet } from '../context/WalletContext';
import EnergyChart from '../components/ui/EnergyChart';
import { analyticsApi, nodesApi, SOCKET_URL, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import PageLoader from '../components/ui/PageLoader';

const SOURCE_ICONS = {
  solar: <Sun size={20} className="text-yellow-400" />,
  wind: <Wind size={20} className="text-blue-400" />,
  home: <Home size={20} className="text-rose-400" />,
};

const Dashboard = () => {
  const [summary, setSummary] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [liveReadings, setLiveReadings] = useState([]);
  const { account } = useWallet();
  const [forecastStatus, setForecastStatus] = useState('Loading...');
  const [socketConnected, setSocketConnected] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const applySummary = useCallback((data) => {
    if (!data) return;
    setSummary(data);
    if (data.recentReadings?.length) {
      setLiveReadings(data.recentReadings.map((r) => ({
        nodeId: r.nodeId?._id || r.nodeId,
        energyGenerated: r.energyGenerated,
        energyConsumed: r.energyConsumed,
        timestamp: r.timestamp,
        nodeName: r.nodeId?.name,
      })));
    }
  }, []);

  const loadDashboard = useCallback(async (wallet, { silent = false } = {}) => {
    try {
      if (!silent) setRefreshing(true);
      setError(null);
      const [summaryRes, nodesRes] = await Promise.all([
        analyticsApi.getSummary(wallet ? { wallet } : {}),
        nodesApi.getAll(),
      ]);

      applySummary(summaryRes.data);
      setNodes(nodesRes.data || []);

      const forecastRes = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000/api/v1'}/forecast`);
      const forecastData = await forecastRes.json();
      if (forecastData.predictions?.length) {
        setForecastStatus(forecastData.meta?.useDummyData ? 'Ready (demo)' : 'Ready');
      } else {
        setForecastStatus('Offline');
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load dashboard data';
      setError(message);
      setForecastStatus('Error');
      if (!silent) toast.error(message);
      return false;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    return true;
  }, [applySummary, toast]);

  useEffect(() => {
    loadDashboard(account);
  }, [account, loadDashboard]);

  useEffect(() => {
    const socket = io(SOCKET_URL);

    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));

    socket.on('newReading', (reading) => {
      setLiveReadings((prev) => {
        const updated = [{
          nodeId: reading.nodeId?._id || reading.nodeId,
          energyGenerated: reading.energyGenerated,
          energyConsumed: reading.energyConsumed,
          timestamp: reading.timestamp,
          nodeName: reading.nodeId?.name,
        }, ...prev];
        return updated.slice(0, 20);
      });

      setSummary((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          energy: {
            ...prev.energy,
            totalGenerated: (prev.energy?.totalGenerated || 0) + (reading.energyGenerated || 0),
            totalConsumed: (prev.energy?.totalConsumed || 0) + (reading.energyConsumed || 0),
            readingCount: (prev.energy?.readingCount || 0) + 1,
          },
        };
      });
    });

    socket.on('analyticsUpdate', (data) => {
      applySummary(data);
    });

    return () => socket.disconnect();
  }, [applySummary]);

  const energy = summary?.energy || {};
  const nodeStats = summary?.nodes || {};
  const tradeStats = summary?.trades || {};
  const carbon = summary?.carbon || {};

  const summaryCards = [
    {
      label: 'Energy Generated',
      value: `${((energy.totalGenerated || 0) / 1000).toFixed(2)} MWh`,
      icon: <Zap size={24} className="text-yellow-400" />,
      trend: `${energy.readingCount || 0} readings`,
      positive: true,
    },
    {
      label: 'Energy Consumed',
      value: `${((energy.totalConsumed || 0) / 1000).toFixed(2)} MWh`,
      icon: <Activity size={24} className="text-rose-400" />,
      trend: 'Grid total',
      positive: false,
    },
    {
      label: 'Active Nodes',
      value: (nodeStats.activeNodes || 0).toLocaleString(),
      icon: <Activity size={24} className="text-blue-400" />,
      trend: `${nodeStats.totalNodes || 0} total`,
      positive: true,
    },
    {
      label: 'Trade Activity',
      value: (tradeStats.completedTrades || 0).toLocaleString(),
      icon: <TrendingUp size={24} className="text-indigo-400" />,
      trend: `${(tradeStats.totalEnergyTraded || 0).toFixed(0)} kWh traded`,
      positive: (tradeStats.completedTrades || 0) > 0,
    },
    {
      label: 'Carbon Credits',
      value: carbon.walletBalance
        ? parseFloat(carbon.walletBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })
        : (carbon.estimatedGridCredits || 0).toLocaleString(),
      icon: <Award size={24} className="text-emerald-400" />,
      trend: `${(carbon.totalCreditsTraded || 0).toFixed(2)} CC traded`,
      positive: true,
    },
    {
      label: 'AI Forecast',
      value: forecastStatus,
      icon: <TrendingUp size={24} className="text-purple-400" />,
      trend: '7-Day',
      positive: forecastStatus.startsWith('Ready'),
    },
  ];

  const nodeStatus = nodes.slice(0, 5).map((node) => ({
    name: node.name,
    type: node.nodeType === 'consumer' ? 'Consumption' : 'Generation',
    status: node.status === 'active' ? 'Optimal' : node.status,
    output: '—',
    icon: SOURCE_ICONS[node.sourceType] || <Zap size={20} className="text-emerald-400" />,
  }));

  if (loading) {
    return <PageLoader message="Loading dashboard analytics..." />;
  }

  return (
    <div className="space-y-6 sm:space-y-8 pb-4 sm:pb-8">
      <SectionTitle
        title="Dashboard Overview"
        subtitle="Real-time grid summary synced from MongoDB, blockchain, and AI services."
        action={
          <button
            type="button"
            disabled={refreshing}
            onClick={async () => {
              const ok = await loadDashboard(account);
              if (ok) toast.success('Dashboard updated');
            }}
            className="touch-target px-5 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-medium rounded-lg transition-colors shadow-lg shadow-emerald-500/20"
          >
            {refreshing ? 'Refreshing...' : 'Refresh Data'}
          </button>
        }
      />

      {error && (
        <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <WalletConnect />
        <BlockchainStatus />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        {summaryCards.map((card, idx) => (
          <SummaryCard key={idx} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl flex flex-col min-h-0">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4 sm:mb-6">
            <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
              <Activity className="text-emerald-400 shrink-0" /> Live Grid Analytics
            </h3>
            <span className={`self-start flex items-center gap-2 text-xs sm:text-sm px-3 py-1 rounded-full border ${
              socketConnected
                ? 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20'
                : 'text-slate-400 bg-slate-700/50 border-slate-600/30'
            }`}>
              <span className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              {socketConnected ? 'Live Sync' : 'Reconnecting...'}
            </span>
          </div>

          <div className="flex-1 w-full mb-6">
            <EnergyChart data={liveReadings} />
          </div>

          <div className="pt-6 border-t border-slate-700/50">
            <h4 className="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wider">Recent Activity Logs</h4>
            <div className="flex flex-col gap-3 max-h-[160px] overflow-y-auto pr-2 custom-scrollbar">
              {liveReadings.length === 0 ? (
                <div className="flex items-center justify-center text-slate-500 py-4">
                  <p>Waiting for live readings...</p>
                </div>
              ) : (
                liveReadings.slice(0, 3).map((reading, i) => (
                  <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-slate-900/50 p-3 rounded-xl border border-slate-700/30">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 bg-emerald-500/10 rounded-lg">
                        <Zap size={16} className="text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm text-slate-300 font-medium">
                          {reading.nodeName || `Node ${String(reading.nodeId).substring(0, 8)}...`}
                        </p>
                        <p className="text-xs text-slate-500">{new Date(reading.timestamp).toLocaleTimeString()}</p>
                      </div>
                    </div>
                    <div className="flex sm:flex-col gap-2 sm:text-right pl-11 sm:pl-0">
                      <p className="text-emerald-400 font-bold text-sm">+{reading.energyGenerated} kW</p>
                      <p className="text-rose-400 font-bold text-sm">-{reading.energyConsumed} kW</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
          <h3 className="text-xl font-bold text-white mb-6">Node Status</h3>
          <div className="space-y-4">
            {nodeStatus.length === 0 ? (
              <p className="text-slate-500 text-sm">No nodes registered. Create nodes via the API or simulator.</p>
            ) : (
              nodeStatus.map((node, idx) => (
                <StatusCard key={idx} {...node} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
