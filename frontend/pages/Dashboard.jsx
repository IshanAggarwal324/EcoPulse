import React from 'react';
import { Zap, Activity, Award, BarChart3, Sun, Wind, Home } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import StatusCard from '../components/ui/StatusCard';

const Dashboard = () => {
  const summaryCards = [
    { label: 'Total Energy', value: '14.2 MWh', icon: <Zap size={24} className="text-yellow-400" />, trend: '+5.2%', positive: true },
    { label: 'Active Nodes', value: '1,248', icon: <Activity size={24} className="text-blue-400" />, trend: '+12', positive: true },
    { label: 'Carbon Credits', value: '8,420', icon: <Award size={24} className="text-emerald-400" />, trend: '+450', positive: true },
    { label: 'Live Trades', value: '342', icon: <BarChart3 size={24} className="text-purple-400" />, trend: '-14%', positive: false },
  ];

  const nodeStatus = [
    { name: 'Solar Node 1', type: 'Generation', status: 'Optimal', output: '45 kW', icon: <Sun size={20} className="text-yellow-400" /> },
    { name: 'Wind Node', type: 'Generation', status: 'Moderate', output: '112 kW', icon: <Wind size={20} className="text-blue-400" /> },
    { name: 'Consumer Node', type: 'Consumption', status: 'High Demand', output: '24 kW', icon: <Home size={20} className="text-rose-400" /> },
  ];

  return (
    <div className="space-y-8 pb-8">
      {/* Page Heading */}
      <SectionTitle 
        title="Dashboard Overview" 
        subtitle="Welcome to EcoPulse. Here is your grid summary." 
        action={
          <button className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors shadow-lg shadow-emerald-500/20 whitespace-nowrap">
            Generate Report
          </button>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {summaryCards.map((card, idx) => (
          <SummaryCard key={idx} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart Placeholder */}
        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl flex flex-col min-h-[400px]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-white">Grid Performance</h3>
            <select className="bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg focus:ring-emerald-500 focus:border-emerald-500 block px-3 py-2">
              <option>Last 24 Hours</option>
              <option>Last 7 Days</option>
              <option>Last 30 Days</option>
            </select>
          </div>
          <div className="flex-1 w-full border border-dashed border-slate-700 rounded-xl flex items-center justify-center bg-slate-900/50">
            <div className="text-center text-slate-500">
              <BarChart3 size={48} className="mx-auto mb-3 opacity-50" />
              <p className="font-medium">Chart Visualization Placeholder</p>
            </div>
          </div>
        </div>

        {/* Node Status Section */}
        <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
          <h3 className="text-xl font-bold text-white mb-6">Node Status</h3>
          <div className="space-y-4">
            {nodeStatus.map((node, idx) => (
              <StatusCard key={idx} {...node} />
            ))}
          </div>
          <button className="w-full mt-6 py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-medium text-sm rounded-lg transition-colors">
            View All Nodes
          </button>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
