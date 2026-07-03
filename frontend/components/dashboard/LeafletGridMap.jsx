import { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// Module 9.5 — leaflet is lazily loaded (code-split) so it never enters the
// main bundle. Tile source is configurable so production can self-host tiles
// instead of leaking user IPs to a third party; OSM is the dev default and
// carries the legally-required attribution.

const TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL ||
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR =
  import.meta.env.VITE_MAP_TILE_ATTR ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const TYPE_COLOR = {
  producer: '#f59e0b',
  consumer: '#f43f5e',
  prosumer: '#10b981',
};
const STATUS_COLOR = {
  failed: '#64748b',
  inactive: '#64748b',
  maintenance: '#eab308',
};

const colorFor = (node) => STATUS_COLOR[node.status] || TYPE_COLOR[node.nodeType] || '#10b981';

const fmt = (v, unit = 'kW') =>
  `${Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '0.0'} ${unit}`;

function LeafletGridMap({ nodes, center, zoom = 4 }) {
  const markers = useMemo(
    () =>
      nodes
        .filter((n) => Number.isFinite(n.coordinates?.lat) && Number.isFinite(n.coordinates?.lng))
        .map((n) => ({
          ...n,
          position: [n.coordinates.lat, n.coordinates.lng],
          color: colorFor(n),
        })),
    [nodes],
  );

  return (
    <div className="relative w-full h-[300px] sm:h-[360px] rounded-xl overflow-hidden border border-slate-700/30">
      <MapContainer
        center={center}
        zoom={zoom}
        scrollWheelZoom={false}
        className="w-full h-full"
        attributionControl
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
        {markers.map((n) => (
          <CircleMarker
            key={n.id}
            center={n.position}
            radius={8}
            pathOptions={{
              color: n.color,
              fillColor: n.color,
              fillOpacity: 0.7,
              weight: 2,
            }}
          >
            <Tooltip direction="top">{n.name}</Tooltip>
            <Popup>
              <div className="space-y-0.5">
                <p className="font-semibold text-sm">{n.name}</p>
                <p className="text-xs">
                  Type: {n.nodeType} · {n.sourceType}
                </p>
                <p className="text-xs">Status: {n.status}</p>
                <p className="text-xs text-emerald-600">
                  Gen: {fmt(n.lastReading?.energyGenerated, n.lastReading?.unit)}
                </p>
                <p className="text-xs text-rose-600">
                  Use: {fmt(n.lastReading?.energyConsumed, n.lastReading?.unit)}
                </p>
                {n.lastReading?.timestamp && (
                  <p className="text-[10px] text-slate-500">
                    {new Date(n.lastReading.timestamp).toLocaleString()}
                  </p>
                )}
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}

export default LeafletGridMap;
