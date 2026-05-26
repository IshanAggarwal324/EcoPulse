import React, { useState, useEffect } from 'react';
import SectionTitle from '../components/ui/SectionTitle';
import { TrendingUp, AlertCircle } from 'lucide-react';
import { forecastApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { Loader2 } from 'lucide-react';

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
            <div className="flex h-40 sm:h-48 items-end gap-2 sm:gap-4 overflow-x-auto pb-2 border-b border-slate-700/50 -mx-2 px-2 sm:mx-0 sm:px-0">
              {forecastData.map((day, idx) => {
                const genHeight = Math.min((day.predicted_generation / 2000) * 100, 100);
                const conHeight = Math.min((day.predicted_consumption / 2000) * 100, 100);
                return (
                  <div key={idx} className="flex-1 flex flex-col items-center gap-2 min-w-[60px]">
                    <div className="flex gap-1 w-full justify-center items-end h-full">
                      <div
                        className="w-4 bg-emerald-400 rounded-t-sm"
                        style={{ height: `${genHeight}%` }}
                        title={`Generation: ${day.predicted_generation.toFixed(2)}`}
                      />
                      <div
                        className="w-4 bg-rose-400 rounded-t-sm"
                        style={{ height: `${conHeight}%` }}
                        title={`Consumption: ${day.predicted_consumption.toFixed(2)}`}
                      />
                    </div>
                    <span className="text-xs text-slate-400">
                      {new Date(day.timestamp).toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-emerald-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                  <span className="font-semibold">Predicted Generation</span>
                </div>
                <p className="text-sm text-slate-400">
                  Avg: {(forecastData.reduce((acc, curr) => acc + curr.predicted_generation, 0) / forecastData.length).toFixed(2)} kW
                </p>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-rose-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-rose-400" />
                  <span className="font-semibold">Predicted Consumption</span>
                </div>
                <p className="text-sm text-slate-400">
                  Avg: {(forecastData.reduce((acc, curr) => acc + curr.predicted_consumption, 0) / forecastData.length).toFixed(2)} kW
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
