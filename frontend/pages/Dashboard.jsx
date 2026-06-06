import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, Sun, Wind, Home, AlertCircle } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import { useWalletState } from '../context/WalletContext';
import { analyticsApi, nodesApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { useSocketReconnect } from '../context/SocketContext';
import { useDashboardRealtime } from '../hooks/useDashboardRealtime';
import { applyFullSummary } from '../utils/dashboardRealtime';
import DashboardSummaryCards from '../components/dashboard/DashboardSummaryCards';
import DashboardWalletSection from '../components/dashboard/DashboardWalletSection';
import DashboardNodePanel from '../components/dashboard/DashboardNodePanel';
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
  const { account } = useWalletState();
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

      const forecastRes = await fetch(
        `${import.meta.env.VITE_API_URL || 'http://localhost:5001/api/v1'}/forecast`
      );
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

  const handleRefresh = useCallback(async () => {
    const ok = await loadDashboard(account);
    if (ok) toast.success('Dashboard updated');
  }, [account, loadDashboard, toast]);

  const refreshAction = useMemo(
    () => (
      <button
        type="button"
        disabled={refreshing}
        onClick={handleRefresh}
        className="touch-target px-5 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-60 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-emerald-500/15"
      >
        {refreshing ? 'Refreshing...' : 'Refresh Data'}
      </button>
    ),
    [refreshing, handleRefresh],
  );

  if (loading) {
    return <PageLoader message="Loading dashboard analytics..." />;
  }

  return (
    <div className="space-y-7 sm:space-y-8 pb-4 sm:pb-8">
      <SectionTitle
        title="Dashboard Overview"
        subtitle="Real-time grid summary synced from MongoDB, blockchain, and AI services."
        action={refreshAction}
      />

      {error && (
        <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 animate-fade-in-up">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      <DashboardWalletSection />

      <DashboardSummaryCards
        energy={energy}
        nodeStats={nodeStats}
        tradeStats={tradeStats}
        carbon={carbon}
        forecastStatus={forecastStatus}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <LiveGridPanel liveReadings={liveReadings} />
        <DashboardNodePanel nodeStatus={nodeStatus} />
      </div>
    </div>
  );
};

export default Dashboard;
