import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import SectionTitle from '../components/ui/SectionTitle';
import { forecastSummary } from '../utils/forecastSummary';

const ForecastChart = lazy(() => import('../components/ui/ForecastChart'));
import { TrendingUp, AlertCircle, Network, GitCompare } from 'lucide-react';
import { forecastApi, nodesApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { Loader2 } from 'lucide-react';

const VIEW_MODES = {
  AGGREGATE: 'aggregate',
  SINGLE: 'single',
  COMPARE: 'compare',
};

const ForecastSummaryCards = ({ predictions }) => {
  const { avgGeneration, avgConsumption, avgConfidence } = forecastSummary(predictions);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-2 text-emerald-400 mb-2">
          <div className="w-3 h-3 rounded-full bg-emerald-400" />
          <span className="font-semibold">Predicted Generation</span>
        </div>
        <p className="text-sm text-slate-400">Avg: {avgGeneration.toFixed(2)} kW</p>
      </div>
      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-2 text-rose-400 mb-2">
          <div className="w-3 h-3 rounded-full bg-rose-400" />
          <span className="font-semibold">Predicted Consumption</span>
        </div>
        <p className="text-sm text-slate-400">Avg: {avgConsumption.toFixed(2)} kW</p>
      </div>
      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-2 text-violet-400 mb-2">
          <div className="w-3 h-3 rounded-full bg-violet-400" />
          <span className="font-semibold">Prediction Confidence</span>
        </div>
        <p className="text-sm text-slate-400">Avg: {avgConfidence.toFixed(0)}%</p>
      </div>
    </div>
  );
};

const Forecasts = () => {
  const [nodes, setNodes] = useState([]);
  const [viewMode, setViewMode] = useState(VIEW_MODES.AGGREGATE);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [forecastData, setForecastData] = useState([]);
  const [nodeForecasts, setNodeForecasts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const toast = useToast();

  useEffect(() => {
    const loadNodes = async () => {
      try {
        const res = await nodesApi.getAll();
        const list = res.data || [];
        setNodes(list);
        if (list.length > 0) {
          setSelectedNodeId(list[0]._id);
        }
      } catch {
        setNodes([]);
      }
    };
    loadNodes();
  }, []);

  const fetchForecasts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setForecastData([]);
      setNodeForecasts([]);

      if (viewMode === VIEW_MODES.COMPARE) {
        if (nodes.length === 0) {
          setError('No energy nodes found. Add nodes to compare forecasts.');
          return;
        }
        const data = await forecastApi.get(7, { allNodes: true });
        setNodeForecasts(data.forecasts || []);
        setMeta(data.meta || null);
        return;
      }

      if (viewMode === VIEW_MODES.SINGLE) {
        if (!selectedNodeId) {
          setError('Select a node to view its forecast.');
          return;
        }
        const data = await forecastApi.get(7, { nodeId: selectedNodeId });
        setForecastData(data.predictions || []);
        setMeta(data.meta || null);
        return;
      }

      const data = await forecastApi.get(7);
      setForecastData(data.predictions || []);
      setMeta(data.meta || null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to fetch forecasts';
      setError(msg);
      toast.error(msg);
      setForecastData([]);
      setNodeForecasts([]);
    } finally {
      setLoading(false);
    }
  }, [viewMode, selectedNodeId, nodes.length, toast]);

  useEffect(() => {
    fetchForecasts();
  }, [fetchForecasts]);

  const chartTitle =
    viewMode === VIEW_MODES.COMPARE
      ? 'Per-node forecast comparison'
      : viewMode === VIEW_MODES.SINGLE
        ? meta?.nodeName
          ? `${meta.nodeName} forecast`
          : 'Node forecast'
        : 'Network aggregate forecast';

  return (
    <div className="space-y-8 pb-8">
      <SectionTitle
        title="AI Forecasts"
        subtitle="7-day predictions per node or across your full energy network."
      />

      <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="text-purple-400" />
            {chartTitle}
            {meta && (
              <span className="text-xs font-normal text-slate-400 ml-2">
                ({meta.useDummyData ? 'demo data' : 'live data'})
              </span>
            )}
          </h3>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex rounded-lg border border-slate-600/60 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.AGGREGATE)}
                className={`px-3 py-2 text-xs sm:text-sm flex items-center gap-1.5 ${
                  viewMode === VIEW_MODES.AGGREGATE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
                }`}
              >
                <Network size={14} />
                Aggregate
              </button>
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.SINGLE)}
                className={`px-3 py-2 text-xs sm:text-sm ${
                  viewMode === VIEW_MODES.SINGLE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
                }`}
              >
                Single node
              </button>
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.COMPARE)}
                className={`px-3 py-2 text-xs sm:text-sm flex items-center gap-1.5 ${
                  viewMode === VIEW_MODES.COMPARE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
                }`}
              >
                <GitCompare size={14} />
                Compare all
              </button>
            </div>

            {viewMode === VIEW_MODES.SINGLE && (
              <select
                value={selectedNodeId}
                onChange={(e) => setSelectedNodeId(e.target.value)}
                className="bg-slate-900/70 border border-slate-600/60 rounded-lg px-3 py-2 text-sm text-slate-200 min-w-[180px]"
                disabled={nodes.length === 0}
              >
                {nodes.length === 0 ? (
                  <option value="">No nodes available</option>
                ) : (
                  nodes.map((node) => (
                    <option key={node._id} value={node._id}>
                      {node.name} ({node.nodeType})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>
        </div>

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
        ) : viewMode === VIEW_MODES.COMPARE ? (
          nodeForecasts.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-slate-400">
              <p>No per-node forecast data available.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {nodeForecasts.map((entry) => (
                <div
                  key={entry.nodeId}
                  className="bg-slate-900/40 border border-slate-700/50 rounded-xl p-4"
                >
                  <h4 className="text-sm font-semibold text-white mb-3">{entry.nodeName}</h4>
                  <Suspense
                    fallback={
                      <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
                        Loading chart...
                      </div>
                    }
                  >
                    <ForecastChart
                      predictions={entry.predictions}
                      compact
                      bandIdPrefix={`node-${entry.nodeId}`}
                    />
                  </Suspense>
                  <ForecastSummaryCards predictions={entry.predictions} />
                </div>
              ))}
            </div>
          )
        ) : forecastData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-400">
            <p>No forecast data available.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="border-b border-slate-700/50 pb-3">
              <Suspense
                fallback={
                  <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
                    Loading chart...
                  </div>
                }
              >
                <ForecastChart predictions={forecastData} bandIdPrefix="main" />
              </Suspense>
            </div>
            <ForecastSummaryCards predictions={forecastData} />
          </div>
        )}
      </div>
    </div>
  );
};

export default Forecasts;
