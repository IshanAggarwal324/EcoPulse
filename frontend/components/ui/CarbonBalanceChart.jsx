import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Coins } from 'lucide-react';

const formatDay = (dateStr) => {
  if (!dateStr || dateStr === 'unknown') return '—';
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const CarbonBalanceChart = ({ walletHistory = [], platformVolume = [], mode = 'wallet' }) => {
  const walletData = walletHistory.map((row) => ({
    ...row,
    label: formatDay(row.date),
  }));

  const platformData = platformVolume.map((row) => ({
    ...row,
    label: formatDay(row.date),
  }));

  const data = mode === 'platform' ? platformData : walletData;
  const isEmpty = data.length === 0;

  if (isEmpty) {
    return (
      <div className="h-56 flex flex-col items-center justify-center text-slate-500 gap-2">
        <Coins size={28} className="text-slate-600" />
        <p className="text-sm">No balance activity in this period</p>
      </div>
    );
  }

  if (mode === 'platform') {
    return (
      <div className="h-64 sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={platformData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis
              yAxisId="left"
              stroke="#94a3b8"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(51, 65, 85, 0.5)',
                borderRadius: '0.75rem',
                color: '#f8fafc',
                fontSize: '12px',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              }}
              formatter={(value, name) => [
                name === 'Trade count' ? value : `${Number(value).toFixed(2)} CC`,
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Bar
              yAxisId="left"
              dataKey="volume"
              name="CC volume"
              fill="#10b981"
              fillOpacity={0.7}
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="tradeCount"
              name="Trade count"
              stroke="#a78bfa"
              strokeWidth={2}
              dot={{ r: 2 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#cbd5e1"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-64 sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={walletData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={48} />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              border: '1px solid rgba(51, 65, 85, 0.5)',
              borderRadius: '0.75rem',
              color: '#f8fafc',
              fontSize: '12px',
              backdropFilter: 'blur(20px)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            }}
            formatter={(value) => [`${Number(value).toFixed(2)} CC`, '']}
            labelFormatter={(label) => label}
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          <Bar dataKey="received" name="Received" fill="#10b981" fillOpacity={0.75} radius={[4, 4, 0, 0]} />
          <Bar dataKey="spent" name="Spent" fill="#f43f5e" fillOpacity={0.75} radius={[4, 4, 0, 0]} />
          <Line
            type="monotone"
            dataKey="cumulativeNet"
            name="Cumulative net"
            stroke="#a78bfa"
            strokeWidth={2.5}
            dot={{ r: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default CarbonBalanceChart;
