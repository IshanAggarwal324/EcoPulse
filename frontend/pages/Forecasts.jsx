import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import SectionTitle from '../components/ui/SectionTitle';
import { forecastSummary } from '../utils/forecastSummary';

const ForecastChart = lazy(() => import('../components/ui/ForecastChart'));
import { TrendingUp, AlertCircle, Network, GitCompare, Sparkles } from 'lucide-react';
import { forecastApi, nodesApi, pricingApi, ApiError } from '../utils/api';
import { useToast } from '../context/ToastContext';
import { Loader2 } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';

const VIEW_MODES = {
  AGGREGATE: 'aggregate',
  SINGLE: 'single',
  COMPARE: 'compare',
};

const ForecastSummaryCards = ({ predictions }) => {
  const { avgGeneration, avgConsumption, avgConfidence } = forecastSummary(predictions);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
      <div className="glass-card p-4 rounded-xl">
        <div className="flex items-center gap-2 text-emerald-400 mb-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          <span className="text-sm font-semibold">Predicted Generation</span>
        </div>
        <p className="text-sm text-slate-400 font-mono">Avg: {avgGeneration.toFixed(2)} kW</p>
      </div>
      <div className="glass-card p-4 rounded-xl">
        <div className="flex items-center gap-2 text-rose-400 mb-2">
          <div className="w-2.5 h-2.5 rounded-full bg-rose-400" />
          <span className="text-sm font-semibold">Predicted Consumption</span>
        </div>
        <p className="text-sm text-slate-400 font-mono">Avg: {avgConsumption.toFixed(2)} kW</p>
      </div>
      <div className="glass-card p-4 rounded-xl">
        <div className="flex items-center gap-2 text-violet-400 mb-2">
          <div className="w-2.5 h-2.5 rounded-full bg-violet-400" />
          <span className="text-sm font-semibold">Prediction Confidence</span>
        </div>
        <p className="text-sm text-slate-400 font-mono">Avg: {avgConfidence.toFixed(0)}%</p>
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
  // Sub-module 2.2 — surplus listing recommendation (single-node view).
  const [surplusRec, setSurplusRec] = useState(null);
  const [surplusLoading, setSurplusLoading] = useState(false);
  const toast = useToast();
  const fallbackNotifiedRef = React.useRef(false);

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
    const fetchWithModelFallback = async (options = {}) => {
      try {
        return await forecastApi.get(7, options);
      } catch (err) {
        if (err instanceof ApiError) {
          const detailsText = JSON.stringify(err.details || {});
          const shouldFallback =
            err.code === 'MODEL_UNAVAILABLE'
            || detailsText.includes('MODEL_UNAVAILABLE')
            || /error communicating with ai service/i.test(err.message || '');

          if (shouldFallback) {
            const fallbackData = await forecastApi.get(7, { ...options, useDummy: true });
            if (!fallbackNotifiedRef.current) {
              toast.info('AI model unavailable — showing forecast from fallback mode');
              fallbackNotifiedRef.current = true;
            }
            return fallbackData;
          }
        }
        throw err;
      }
    };

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
        const data = await fetchWithModelFallback({ allNodes: true });
        setNodeForecasts(data.forecasts || []);
        setMeta(data.meta || null);
        return;
      }

      if (viewMode === VIEW_MODES.SINGLE) {
        if (!selectedNodeId) {
          setError('Select a node to view its forecast.');
          return;
        }
        const data = await fetchWithModelFallback({ nodeId: selectedNodeId });
        setForecastData(data.predictions || []);
        setMeta(data.meta || null);
        return;
      }

      const data = await fetchWithModelFallback();
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

  // Fetch a surplus listing recommendation for the selected node (2.2.5).
  useEffect(() => {
    if (viewMode !== VIEW_MODES.SINGLE || !selectedNodeId) {
      setSurplusRec(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setSurplusLoading(true);
      try {
        const res = await pricingApi.getRecommendation({ nodeId: selectedNodeId });
        if (!cancelled) setSurplusRec(res.data || null);
      } catch {
        if (!cancelled) setSurplusRec(null);
      } finally {
        if (!cancelled) setSurplusLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [viewMode, selectedNodeId]);

  const chartTitle =
    viewMode === VIEW_MODES.COMPARE
      ? 'Per-node forecast comparison'
      : viewMode === VIEW_MODES.SINGLE
        ? meta?.nodeName
          ? `${meta.nodeName} forecast`
          : 'Node forecast'
        : 'Network aggregate forecast';

  return (
    <div className="page-section">
      <SectionTitle
        title="AI Forecasts"
        subtitle="7-day predictions per node or across your full energy network."
      />

      <div className="content-card">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <div className="p-1.5 bg-purple-500/10 rounded-lg">
              <TrendingUp className="text-purple-400" size={18} />
            </div>
            {chartTitle}
            {meta && (
              <span className="text-xs font-normal text-slate-500 ml-2">
                ({meta.useDummyData ? 'demo data' : 'live data'})
              </span>
            )}
          </h3>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex rounded-xl border border-slate-600/40 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.AGGREGATE)}
                className={`px-3 py-2 text-xs sm:text-sm flex items-center gap-1.5 transition-colors ${
                  viewMode === VIEW_MODES.AGGREGATE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
                }`}
              >
                <Network size={14} />
                Aggregate
              </button>
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.SINGLE)}
                className={`px-3 py-2 text-xs sm:text-sm transition-colors ${
                  viewMode === VIEW_MODES.SINGLE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
                }`}
              >
                Single node
              </button>
              <button
                type="button"
                onClick={() => setViewMode(VIEW_MODES.COMPARE)}
                className={`px-3 py-2 text-xs sm:text-sm flex items-center gap-1.5 transition-colors ${
                  viewMode === VIEW_MODES.COMPARE
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-900/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
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
                className="bg-slate-900/60 border border-slate-600/40 rounded-xl px-3 py-2 text-sm text-slate-200 min-w-[180px] focus:outline-none focus:border-purple-500/50"
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
          <div className="h-48 sm:h-64 flex flex-col items-center justify-center text-slate-400 gap-3">
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/15 rounded-full blur-lg animate-pulse" />
              <Loader2 className="relative h-8 w-8 animate-spin text-emerald-500" />
            </div>
            <p className="text-sm">Generating predictions...</p>
          </div>
        ) : error ? (
          <div className="h-64 flex flex-col items-center justify-center text-rose-400 gap-3 animate-fade-in-up">
            <AlertCircle size={32} />
            <p className="font-medium">{error}</p>
            <p className="text-sm text-slate-600">Ensure the AI service is running on port 8000</p>
          </div>
        ) : viewMode === VIEW_MODES.COMPARE ? (
          nodeForecasts.length === 0 ? (
            <EmptyState
              illustration="nodes"
              title="No forecast data available"
              description="Add energy nodes to the system to generate per-node forecasts."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {nodeForecasts.map((entry) => (
                <div
                  key={entry.nodeId}
                  className="bg-slate-900/30 border border-slate-700/30 rounded-xl p-4"
                >
                  <h4 className="text-sm font-semibold text-white mb-3">{entry.nodeName}</h4>
                  <Suspense
                    fallback={
                      <div className="h-48 flex items-center justify-center text-slate-600 text-sm">
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
          <EmptyState
            illustration="energy"
            title="No forecast data available"
            description="The AI service needs energy readings to generate predictions."
          />
        ) : (
          <div className="space-y-6">
            <div className="border-b border-slate-700/30 pb-3">
              <Suspense
                fallback={
                  <div className="h-64 flex items-center justify-center text-slate-600 text-sm">
                    Loading chart...
                  </div>
                }
              >
                <ForecastChart predictions={forecastData} bandIdPrefix="main" />
              </Suspense>
            </div>
            <ForecastSummaryCards predictions={forecastData} />

            {viewMode === VIEW_MODES.SINGLE && selectedNodeId && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                {surplusLoading ? (
                  <p className="text-sm text-slate-400 flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> Checking forecast surplus...
                  </p>
                ) : surplusRec ? (
                  <>
                    <div className="flex items-center gap-2 text-emerald-300 mb-3">
                      <Sparkles size={18} />
                      <h4 className="text-sm font-semibold">Surplus & listing suggestion</h4>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-3">
                      <div>
                        <p className="text-slate-500">Forecast surplus</p>
                        <p className="text-slate-200 font-mono">{surplusRec.surplus.totalSurplusKwh} kWh</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Peak surplus</p>
                        <p className="text-slate-200 font-mono">{surplusRec.surplus.peakSurplusKw} kW</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Suggested unit</p>
                        <p className="text-slate-200 font-mono">{surplusRec.unitPriceCc} CC/kWh</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Suggested total</p>
                        <p className="text-slate-200 font-mono">{surplusRec.totalPriceCc} CC</p>
                      </div>
                    </div>
                    {surplusRec.eligible ? (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        <Link
                          to="/trading"
                          className="touch-target inline-flex items-center justify-center gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                        >
                          <Sparkles size={14} /> List this surplus
                        </Link>
                        <span className="text-[11px] text-slate-500">{surplusRec.disclaimer}</span>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-300">
                        Not recommended right now: {surplusRec.reasons.join('; ')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No surplus recommendation available for this node.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Forecasts;
