import React, { memo } from 'react';
import { Activity, Zap } from 'lucide-react';
import SocketStatusBadge from '../ui/SocketStatusBadge';

const EnergyChart = React.lazy(() => import('../ui/EnergyChart'));

const LiveGridPanel = memo(function LiveGridPanel({ liveReadings }) {
  return (
    <div className="lg:col-span-2 glass-card rounded-2xl p-5 sm:p-6 glow-emerald card-hover-glow flex flex-col min-h-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-5 sm:mb-6">
        <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2.5">
          <div className="p-1.5 bg-emerald-500/10 rounded-lg">
            <Activity className="text-emerald-400 shrink-0" size={18} />
          </div>
          Live Grid Analytics
        </h3>
        <SocketStatusBadge className="self-start" />
      </div>

      <div className="flex-1 w-full mb-6">
        <React.Suspense
          fallback={
            <div className="w-full h-[220px] sm:h-[280px] lg:h-[300px] flex items-center justify-center text-slate-500">
              <p className="text-sm animate-shimmer px-8 py-3 rounded-lg">Loading chart...</p>
            </div>
          }
        >
          <EnergyChart data={liveReadings} />
        </React.Suspense>
      </div>

      <div className="pt-5 border-t border-slate-700/30">
        <h4 className="text-[10px] font-semibold text-slate-500 mb-4 uppercase tracking-[0.15em]">Recent Activity</h4>
        <div className="flex flex-col gap-2.5 max-h-[160px] overflow-y-auto pr-1 custom-scrollbar">
          {liveReadings.length === 0 ? (
            <div className="flex items-center justify-center text-slate-500 py-4">
              <p className="text-sm">Waiting for live readings...</p>
            </div>
          ) : (
            liveReadings.slice(0, 3).map((reading) => (
              <div
                key={reading.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-slate-900/40 p-3 rounded-xl border border-slate-700/20 hover:border-slate-600/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-1.5 bg-emerald-500/10 rounded-lg">
                    <Zap size={14} className="text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm text-slate-300 font-medium">
                      {reading.nodeName || `Node ${String(reading.nodeId).substring(0, 8)}...`}
                    </p>
                    <p className="text-[11px] text-slate-500">{new Date(reading.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
                <div className="flex sm:flex-col gap-2 sm:text-right pl-9 sm:pl-0">
                  <p className="text-emerald-400 font-bold text-sm">+{reading.energyGenerated} kW</p>
                  <p className="text-rose-400 font-bold text-sm">-{reading.energyConsumed} kW</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
});

export default LiveGridPanel;
