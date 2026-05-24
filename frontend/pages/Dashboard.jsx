import React, { useState, useEffect } from 'react';
import { Zap, Activity, Award, BarChart3, Sun, Wind, Home, Rss, TrendingUp } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import StatusCard from '../components/ui/StatusCard';
import io from 'socket.io-client';
import WalletConnect from '../components/WalletConnect';
import BlockchainStatus from '../components/BlockchainStatus';
import EnergyChart from '../components/ui/EnergyChart';

const Dashboard = () => {
  const [totalEnergy, setTotalEnergy] = useState(14200); // base in kWh
  const [activeNodes, setActiveNodes] = useState(1248);
  const [account, setAccount] = useState(null);
  const [liveReadings, setLiveReadings] = useState([]);
  const [forecastStatus, setForecastStatus] = useState('Loading...');
  
  useEffect(() => {
    // Connect to the backend Socket.io server
    const socket = io('http://localhost:5000');

    socket.on('connect', () => {
      console.log('Connected to real-time data feed');
    });

    socket.on('newReading', (reading) => {
      // Update total energy
      setTotalEnergy((prev) => prev + reading.energyGenerated);
      
      // Update live readings list
      setLiveReadings((prev) => {
        const updated = [reading, ...prev];
        return updated.slice(0, 20); // keep last 20 readings for the chart
      });
    });

    // Fetch initial forecast status
    fetch('http://localhost:5000/api/v1/forecast')
      .then(res => res.json())
      .then(data => {
        if(data && data.predictions) setForecastStatus('Ready');
        else setForecastStatus('Offline');
      })
      .catch(() => setForecastStatus('Error'));

    return () => {
      socket.disconnect();
    };
  }, []);
  const summaryCards = [
    { label: 'Total Energy', value: `${(totalEnergy / 1000).toFixed(2)} MWh`, icon: <Zap size={24} className="text-yellow-400" />, trend: 'Live', positive: true },
    { label: 'Active Nodes', value: activeNodes.toLocaleString(), icon: <Activity size={24} className="text-blue-400" />, trend: '+12', positive: true },
    { label: 'Carbon Credits', value: '8,420', icon: <Award size={24} className="text-emerald-400" />, trend: '+450', positive: true },
    { label: 'AI Forecast', value: forecastStatus, icon: <TrendingUp size={24} className="text-purple-400" />, trend: '7-Day', positive: forecastStatus === 'Ready' },
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

      {/* Wallet & Blockchain Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <WalletConnect 
          onConnect={(acc) => setAccount(acc)} 
          onDisconnect={() => setAccount(null)} 
          account={account} 
        />
        <BlockchainStatus account={account} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {summaryCards.map((card, idx) => (
          <SummaryCard key={idx} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Monitoring Chart Section */}
        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl flex flex-col min-h-[400px]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <Activity className="text-emerald-400" /> Live Grid Analytics
            </h3>
            <span className="flex items-center gap-2 text-sm text-emerald-400 bg-emerald-400/10 px-3 py-1 rounded-full border border-emerald-500/20">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Socket Connected
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
                  <div key={i} className="flex items-center justify-between bg-slate-900/50 p-3 rounded-xl border border-slate-700/30">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-emerald-500/10 rounded-lg">
                        <Zap size={16} className="text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm text-slate-300 font-medium">Node: {reading.nodeId.substring(0, 8)}...</p>
                        <p className="text-xs text-slate-500">{new Date(reading.timestamp).toLocaleTimeString()}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-emerald-400 font-bold text-sm">+{reading.energyGenerated} kW</p>
                      <p className="text-rose-400 font-bold text-sm">-{reading.energyConsumed} kW</p>
                    </div>
                  </div>
                ))
              )}
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
