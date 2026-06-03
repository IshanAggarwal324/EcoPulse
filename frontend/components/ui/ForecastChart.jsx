import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Area,
  Line,
  Legend,
} from 'recharts';

const buildChartData = (predictions) =>
  predictions.map((day, idx) => {
    const fallbackConfidence = Math.max(0.55, 0.92 - idx * 0.05);
    const confidence = day.confidence ?? fallbackConfidence;
    const uncertaintyPct = 1 - confidence;

    const generationLower =
      day.generation_lower ?? Math.max(0, day.predicted_generation * (1 - uncertaintyPct));
    const generationUpper = day.generation_upper ?? day.predicted_generation * (1 + uncertaintyPct);
    const consumptionLower =
      day.consumption_lower ?? Math.max(0, day.predicted_consumption * (1 - uncertaintyPct));
    const consumptionUpper =
      day.consumption_upper ?? day.predicted_consumption * (1 + uncertaintyPct);

    return {
      ...day,
      generation_lower: generationLower,
      generation_upper: generationUpper,
      consumption_lower: consumptionLower,
      consumption_upper: consumptionUpper,
      dayLabel: new Date(day.timestamp).toLocaleDateString(undefined, {
        weekday: 'short',
      }),
      confidencePercent: Math.round(confidence * 100),
    };
  });

const tooltipFormatter = (value, name) => {
  if (name.toLowerCase().includes('confidence')) {
    return [`${Math.round(value)}%`, name];
  }
  return [`${Number(value).toFixed(2)} kW`, name];
};

const ForecastChart = ({ predictions, compact = false, bandIdPrefix = 'fc' }) => {
  const chartData = buildChartData(predictions);

  if (!predictions?.length) {
    return (
      <div className={`flex items-center justify-center text-slate-400 ${compact ? 'h-48' : 'h-64'}`}>
        <p className="text-sm">No forecast data available.</p>
      </div>
    );
  }

  const genBandId = `${bandIdPrefix}-gen`;
  const conBandId = `${bandIdPrefix}-con`;

  return (
    <div className={compact ? 'h-56' : 'h-72 sm:h-80 lg:h-96'}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={genBandId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.24} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id={conBandId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis dataKey="dayLabel" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis
            yAxisId="power"
            stroke="#94a3b8"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `${value}`}
          />
          <YAxis
            yAxisId="confidence"
            orientation="right"
            stroke="#cbd5e1"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
          />
          <Tooltip
            formatter={tooltipFormatter}
            contentStyle={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.75rem',
              color: '#f8fafc',
              fontSize: '12px',
            }}
            labelStyle={{ color: '#cbd5e1' }}
          />
          {!compact && <Legend wrapperStyle={{ fontSize: '12px' }} />}

          <Area
            yAxisId="power"
            type="monotone"
            dataKey="generation_upper"
            stroke="none"
            fill={`url(#${genBandId})`}
            fillOpacity={1}
            legendType="none"
            activeDot={false}
          />
          <Area
            yAxisId="power"
            type="monotone"
            dataKey="generation_lower"
            stroke="none"
            fill="#0f172a"
            fillOpacity={1}
            legendType="none"
            activeDot={false}
          />
          <Area
            yAxisId="power"
            type="monotone"
            dataKey="consumption_upper"
            stroke="none"
            fill={`url(#${conBandId})`}
            fillOpacity={1}
            legendType="none"
            activeDot={false}
          />
          <Area
            yAxisId="power"
            type="monotone"
            dataKey="consumption_lower"
            stroke="none"
            fill="#0f172a"
            fillOpacity={1}
            legendType="none"
            activeDot={false}
          />
          <Line
            yAxisId="power"
            type="monotone"
            dataKey="predicted_generation"
            stroke="#10b981"
            strokeWidth={2.5}
            dot={{ r: 3 }}
            name="Predicted generation"
          />
          <Line
            yAxisId="power"
            type="monotone"
            dataKey="predicted_consumption"
            stroke="#f43f5e"
            strokeWidth={2.5}
            dot={{ r: 3 }}
            name="Predicted consumption"
          />
          <Line
            yAxisId="confidence"
            type="monotone"
            dataKey="confidencePercent"
            stroke="#a78bfa"
            strokeDasharray="6 4"
            strokeWidth={2}
            dot={{ r: 2 }}
            name="Prediction confidence"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ForecastChart;
