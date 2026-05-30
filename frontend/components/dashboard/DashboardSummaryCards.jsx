import React, { memo, useMemo } from 'react';
import { Zap, Activity, Award, TrendingUp } from 'lucide-react';
import SummaryCard from '../ui/SummaryCard';

const DashboardSummaryCards = memo(function DashboardSummaryCards({
  energy,
  nodeStats,
  tradeStats,
  carbon,
  forecastStatus,
}) {
  const summaryCards = useMemo(() => [
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
      trend: carbon.balanceAnalytics?.wallet
        ? `Net ${(carbon.balanceAnalytics.wallet.netFlow || 0).toFixed(2)} CC (30d)`
        : `${(carbon.totalCreditsTraded || 0).toFixed(2)} CC traded`,
      positive: (carbon.balanceAnalytics?.wallet?.netFlow ?? 1) >= 0,
    },
    {
      label: 'AI Forecast',
      value: forecastStatus,
      icon: <TrendingUp size={24} className="text-purple-400" />,
      trend: '7-Day',
      positive: forecastStatus.startsWith('Ready'),
    },
  ], [energy, nodeStats, tradeStats, carbon, forecastStatus]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
      {summaryCards.map((card) => (
        <SummaryCard key={card.label} {...card} />
      ))}
    </div>
  );
});

export default DashboardSummaryCards;
