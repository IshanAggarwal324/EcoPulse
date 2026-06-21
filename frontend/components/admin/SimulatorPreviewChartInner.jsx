import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

export default function SimulatorPreviewChartInner({ data }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="simPreviewGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="hour"
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickFormatter={(h) => `${h}h`}
          interval={2}
        />
        <YAxis tick={{ fill: '#64748b', fontSize: 11 }} domain={[0, 'auto']} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 12, fontSize: 12 }}
          labelStyle={{ color: '#94a3b8' }}
          labelFormatter={(h) => `${h}:00`}
          formatter={(v) => [Number(v).toFixed(2), 'factor']}
        />
        <Area type="monotone" dataKey="factor" stroke="#10b981" strokeWidth={2} fill="url(#simPreviewGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
