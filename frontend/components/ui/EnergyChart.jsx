import React, { memo, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Zap } from 'lucide-react';

function buildChartData(data) {
  return [...data].reverse().map((d) => {
    const date = new Date(d.timestamp);
    const isToday = date.toDateString() === new Date().toDateString();
    return {
      name: isToday
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      generated: d.energyGenerated,
      consumed: d.energyConsumed,
    };
  });
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-xl p-3 shadow-xl shadow-black/30">
      <p className="text-[11px] text-slate-500 mb-2">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-sm">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-slate-400">{entry.name}:</span>
          <span className="font-semibold text-white">{entry.value} kW</span>
        </div>
      ))}
    </div>
  );
};

const EnergyChart = memo(function EnergyChart({ data }) {
  const chartData = useMemo(() => (data?.length ? buildChartData(data) : []), [data]);

  if (!chartData.length) {
    return (
      <div className="w-full h-[220px] sm:h-[280px] lg:h-[300px] flex items-center justify-center text-slate-500 flex-col gap-2">
        <Zap className="animate-pulse text-slate-700" size={32} />
        <p className="text-sm text-center px-4">Waiting for live node data...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-[220px] sm:h-[280px] lg:h-[300px] min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="colorGenerated" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorConsumed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" vertical={false} />
          <XAxis
            dataKey="name"
            stroke="#475569"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#475569"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(value) => `${value}`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="generated"
            name="Generated"
            stroke="#10b981"
            strokeWidth={2.5}
            fillOpacity={1}
            fill="url(#colorGenerated)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="consumed"
            name="Consumed"
            stroke="#f43f5e"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#colorConsumed)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

export default EnergyChart;
