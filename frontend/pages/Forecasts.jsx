import React, { useState, useEffect } from 'react';
import SectionTitle from '../components/ui/SectionTitle';
import { TrendingUp, AlertCircle } from 'lucide-react';
import { forecastApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { Loader2 } from 'lucide-react';
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

const Forecasts = () => {
  const [forecastData, setForecastData] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const toast = useToast();

  useEffect(() => {
    const fetchForecasts = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await forecastApi.get(7);
        setForecastData(data.predictions || []);
        setMeta(data.meta || null);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Failed to fetch forecasts';
        setError(msg);
        toast.error(msg);
        setForecastData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchForecasts();
  }, []);

  const chartData = forecastData.map((day, idx) => {
    const fallbackConfidence = Math.max(0.55, 0.92 - idx * 0.05);
    const confidence = day.confidence ?? fallbackConfidence;
    const uncertaintyPct = 1 - confidence;

    const generationLower =
      day.generation_lower ?? Math.max(0, day.predicted_generation * (1 - uncertaintyPct));
    const generationUpper = day.generation_upper ?? day.predicted_generation * (1 + uncertaintyPct);
    const consumptionLower =
      day.consumption_lower ?? Math.max(0, day.predicted_consumption * (1 - uncertaintyPct));
    const consumptionUpper = day.consumption_upper ?? day.predicted_consumption * (1 + uncertaintyPct);

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

  const avgGeneration =
    forecastData.length > 0
      ? forecastData.reduce((acc, curr) => acc + curr.predicted_generation, 0) / forecastData.length
      : 0;
  const avgConsumption =
    forecastData.length > 0
      ? forecastData.reduce((acc, curr) => acc + curr.predicted_consumption, 0) / forecastData.length
      : 0;
  const avgConfidence =
    forecastData.length > 0
      ? (forecastData.reduce((acc, curr) => acc + (curr.confidence ?? 0), 0) / forecastData.length) * 100
      : 0;

  const tooltipFormatter = (value, name) => {
    if (name.toLowerCase().includes('confidence')) {
      return [`${Math.round(value)}%`, name];
    }
    return [`${Number(value).toFixed(2)} kW`, name];
  };

  return (
    <div className="space-y-8 pb-8">
      <SectionTitle
        title="AI Forecasts"
        subtitle="7-day AI prediction synced with MongoDB readings when available."
      />

      <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <TrendingUp className="text-purple-400" /> Generation vs Consumption Forecast
          {meta && (
            <span className="text-xs font-normal text-slate-400 ml-2">
              ({meta.useDummyData ? 'demo data' : 'live data'})
            </span>
          )}
        </h3>

        {loading ? (
          <div className="h-48 sm:h-64 flex flex-col items-center justify-center text-slate-400 gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <p className="text-sm">Generating predictions...</p>
          </div>
        ) : error ? (
          <div className="h-64 flex flex-col items-center justify-center text-rose-400 gap-3">
            <AlertCircle size={32} />
            <p>{error}</p>
            <p className="text-sm text-slate-500">Ensure the AI service is running on port 8000</p>
          </div>
        ) : forecastData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-400">
            <p>No forecast data available.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="h-72 sm:h-80 lg:h-96 border-b border-slate-700/50 pb-3">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="genBand" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.24} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="conBand" x1="0" y1="0" x2="0" y2="1">
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
                  <Legend wrapperStyle={{ fontSize: '12px' }} />

                  <Area
                    yAxisId="power"
                    type="monotone"
                    dataKey="generation_upper"
                    stroke="none"
                    fill="url(#genBand)"
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
                    fill="url(#conBand)"
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-emerald-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                  <span className="font-semibold">Predicted Generation</span>
                </div>
                <p className="text-sm text-slate-400">
                  Avg: {avgGeneration.toFixed(2)} kW
                </p>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-rose-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-rose-400" />
                  <span className="font-semibold">Predicted Consumption</span>
                </div>
                <p className="text-sm text-slate-400">
                  Avg: {avgConsumption.toFixed(2)} kW
                </p>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-violet-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-violet-400" />
                  <span className="font-semibold">Prediction Confidence</span>
                </div>
                <p className="text-sm text-slate-400">
                  Avg: {avgConfidence.toFixed(0)}%
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Forecasts;
