import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, Sun, Wind, Home, AlertCircle } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import StatusCard from '../components/ui/StatusCard';
import WalletConnect from '../components/WalletConnect';
import BlockchainStatus from '../components/BlockchainStatus';
import { useWallet } from '../context/WalletContext';
import { analyticsApi, nodesApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { useSocketReconnect } from '../context/SocketContext';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import { applyFullSummary } from '../utils/dashboardRealtime';
import DashboardSummaryCards from '../components/dashboard/DashboardSummaryCards';
import LiveGridPanel from '../components/dashboard/LiveGridPanel';
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
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  useDashboardRealtime({ setSummary, setLiveReadings });

  const loadDashboard = useCallback(async (wallet, { silent = false } = {}) => {
    try {
      if (!silent) setRefreshing(true);
      setError(null);
      const [summaryRes, nodesRes] = await Promise.all([
        analyticsApi.getSummary(wallet ? { wallet } : {}),
        nodesApi.getAll(),
      ]);

      const { summary: nextSummary, readings } = applyFullSummary(summaryRes.data);
      if (nextSummary) setSummary(nextSummary);
      if (readings) setLiveReadings(readings);
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
  }, [toast]);

  useEffect(() => {
    loadDashboard(account);
  }, [account, loadDashboard]);

  useSocketReconnect(() => {
    loadDashboard(account, { silent: true });
    toast.info('Live connection restored — dashboard synced');
  });

  const energy = summary?.energy || {};
  const nodeStats = summary?.nodes || {};
  const tradeStats = summary?.trades || {};
  const carbon = summary?.carbon || {};

  const nodeStatus = useMemo(
    () => nodes.slice(0, 5).map((node) => ({
      name: node.name,
      type: node.nodeType === 'consumer' ? 'Consumption' : 'Generation',
      status: node.status === 'active' ? 'Optimal' : node.status,
      output: '—',
      icon: SOURCE_ICONS[node.sourceType] || <Zap size={20} className="text-emerald-400" />,
    })),
    [nodes],
  );

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

      <DashboardSummaryCards
        energy={energy}
        nodeStats={nodeStats}
        tradeStats={tradeStats}
        carbon={carbon}
        forecastStatus={forecastStatus}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <LiveGridPanel liveReadings={liveReadings} />

        <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
          <h3 className="text-xl font-bold text-white mb-6">Node Status</h3>
          <div className="space-y-4">
            {nodeStatus.length === 0 ? (
              <p className="text-slate-500 text-sm">No nodes registered. Create nodes via the API or simulator.</p>
            ) : (
              nodeStatus.map((node) => (
                <StatusCard key={node.name} {...node} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
