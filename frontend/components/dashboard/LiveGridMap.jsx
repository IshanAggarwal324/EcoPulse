import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { Activity, MapPin, AlertCircle } from 'lucide-react';
import { nodesApi, ApiError } from '../../utils/api';
import { useSocketEvent, useSocketReconnect } from '../../context/SocketContext';
import { SOCKET_EVENTS } from '../../constants/socketEvents';
import SocketStatusBadge from '../ui/SocketStatusBadge';

// Leaflet is heavy and only needed when mappable nodes exist — load on demand.
const LeafletGridMap = lazy(() => import('./LeafletGridMap'));

const DEFAULT_CENTER = [20, 0];

const computeCenter = (nodes) => {
  const pts = nodes.filter(
    (n) => Number.isFinite(n.coordinates?.lat) && Number.isFinite(n.coordinates?.lng),
  );
  if (!pts.length) return DEFAULT_CENTER;
  const sum = pts.reduce(
    (acc, n) => [acc[0] + n.coordinates.lat, acc[1] + n.coordinates.lng],
    [0, 0],
  );
  return [sum[0] / pts.length, sum[1] / pts.length];
};

const LiveGridMap = () => {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await nodesApi.getMap();
      setNodes(res.data || []);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load grid map');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useSocketReconnect(() => {
    load();
  });

  // Live updates: fold incoming readings into the matching marker's lastReading.
  useSocketEvent(SOCKET_EVENTS.SERVER.NEW_READING, (reading) => {
    if (!reading?.nodeId) return;
    const id = String(reading.nodeId);
    setNodes((prev) =>
      prev.map((n) =>
        n.id === id
          ? {
              ...n,
              lastReading: {
                energyGenerated: Number(reading.energyGenerated) || 0,
                energyConsumed: Number(reading.energyConsumed) || 0,
                timestamp: reading.timestamp || n.lastReading?.timestamp || null,
                unit: reading.unit || n.lastReading?.unit || 'kW',
              },
            }
          : n,
      ),
    );
  });

  const center = useMemo(() => computeCenter(nodes), [nodes]);

  const mapFallback = (text) => (
    <div className="w-full h-[300px] sm:h-[360px] flex items-center justify-center text-slate-500">
      <p className="text-sm animate-shimmer px-8 py-3 rounded-lg">{text}</p>
    </div>
  );

  return (
    <div className="lg:col-span-2 glass-card rounded-2xl p-5 sm:p-6 glow-emerald card-hover-glow flex flex-col min-h-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-5 sm:mb-6">
        <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2.5">
          <div className="p-1.5 bg-emerald-500/10 rounded-lg">
            <Activity className="text-emerald-400 shrink-0" size={18} />
          </div>
          Live Grid Map
        </h3>
        <SocketStatusBadge className="self-start" />
      </div>

      <div className="flex-1 w-full">
        {loading ? (
          mapFallback('Loading map...')
        ) : error ? (
          <div className="w-full h-[300px] sm:h-[360px] flex flex-col items-center justify-center gap-2 text-rose-300">
            <AlertCircle size={20} />
            <p className="text-sm">{error}</p>
          </div>
        ) : nodes.length === 0 ? (
          <div className="w-full h-[300px] sm:h-[360px] flex flex-col items-center justify-center gap-2 text-slate-500">
            <MapPin size={20} />
            <p className="text-sm">No nodes with coordinates yet.</p>
            <p className="text-xs text-slate-600">Set node coordinates in admin to see them on the map.</p>
          </div>
        ) : (
          <Suspense fallback={mapFallback('Loading map...')}>
            <LeafletGridMap nodes={nodes} center={center} zoom={4} />
          </Suspense>
        )}
      </div>

      {!loading && !error && nodes.length > 0 && (
        <div className="pt-4 mt-4 border-t border-slate-700/30 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Producer
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Consumer
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Prosumer
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-500" /> Inactive/Failed
          </span>
          <span className="ml-auto">{nodes.length} mapped</span>
        </div>
      )}
    </div>
  );
};

export default React.memo(LiveGridMap);
