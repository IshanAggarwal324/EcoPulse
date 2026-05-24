import React, { useState, useEffect } from 'react';
import SectionTitle from '../components/ui/SectionTitle';
import { Activity, Zap, TrendingUp, AlertCircle } from 'lucide-react';

const Forecasts = () => {
  const [forecastData, setForecastData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchForecasts = async () => {
      try {
        setLoading(true);
        const res = await fetch('http://localhost:5000/api/v1/forecast');
        if (!res.ok) throw new Error('Failed to fetch forecasts');
        const data = await res.json();
        if (data.predictions) {
          setForecastData(data.predictions);
        } else {
          setForecastData([]);
        }
      } catch (err) {
        console.error("Forecast Error:", err);
        setError(err.message);
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
        subtitle="7-day AI prediction of grid generation vs consumption" 
      />

      <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <TrendingUp className="text-purple-400" /> Generation vs Consumption Forecast
        </h3>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-slate-400 animate-pulse">
            <p>Training AI & generating predictions...</p>
          </div>
        ) : error ? (
          <div className="h-64 flex flex-col items-center justify-center text-rose-400 gap-3">
            <AlertCircle size={32} />
            <p>{error}</p>
            <p className="text-sm text-slate-500">Make sure AI service is running on port 8000</p>
          </div>
        ) : forecastData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-400">
            <p>No forecast data available.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Simple CSS Bar Chart Representation */}
            <div className="flex h-48 items-end gap-4 overflow-x-auto pb-2 border-b border-slate-700/50">
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
                      ></div>
                      <div 
                        className="w-4 bg-rose-400 rounded-t-sm" 
                        style={{ height: `${conHeight}%` }}
                        title={`Consumption: ${day.predicted_consumption.toFixed(2)}`}
                      ></div>
                    </div>
                    <span className="text-xs text-slate-400">
                      {new Date(day.timestamp).toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Legend & Details */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-emerald-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400"></div>
                  <span className="font-semibold">Predicted Generation</span>
                </div>
                <p className="text-sm text-slate-400">Avg: {(forecastData.reduce((acc, curr) => acc + curr.predicted_generation, 0) / forecastData.length).toFixed(2)} kW</p>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <div className="flex items-center gap-2 text-rose-400 mb-2">
                  <div className="w-3 h-3 rounded-full bg-rose-400"></div>
                  <span className="font-semibold">Predicted Consumption</span>
                </div>
                <p className="text-sm text-slate-400">Avg: {(forecastData.reduce((acc, curr) => acc + curr.predicted_consumption, 0) / forecastData.length).toFixed(2)} kW</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Forecasts;
