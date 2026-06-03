import React, { lazy, memo, Suspense } from 'react';
import { Activity, Zap } from 'lucide-react';
import SocketStatusBadge from '../ui/SocketStatusBadge';

const EnergyChart = lazy(() => import('../ui/EnergyChart'));

const LiveGridPanel = memo(function LiveGridPanel({ liveReadings }) {
  return (
    <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl flex flex-col min-h-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4 sm:mb-6">
        <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
          <Activity className="text-emerald-400 shrink-0" /> Live Grid Analytics
        </h3>
        <SocketStatusBadge className="self-start" />
      </div>

      <div className="flex-1 w-full mb-6">
        <Suspense
          fallback={
            <div className="w-full h-[220px] sm:h-[280px] lg:h-[300px] flex items-center justify-center text-slate-500">
              <p className="text-sm">Loading chart...</p>
            </div>
          }
        >
          <EnergyChart data={liveReadings} />
        </Suspense>
      </div>

      <div className="pt-6 border-t border-slate-700/50">
        <h4 className="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wider">Recent Activity Logs</h4>
        <div className="flex flex-col gap-3 max-h-[160px] overflow-y-auto pr-2 custom-scrollbar">
          {liveReadings.length === 0 ? (
            <div className="flex items-center justify-center text-slate-500 py-4">
              <p>Waiting for live readings...</p>
            </div>
          ) : (
            liveReadings.slice(0, 3).map((reading) => (
              <div
                key={reading.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-slate-900/50 p-3 rounded-xl border border-slate-700/30"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <Zap size={16} className="text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm text-slate-300 font-medium">
                      {reading.nodeName || `Node ${String(reading.nodeId).substring(0, 8)}...`}
                    </p>
                    <p className="text-xs text-slate-500">{new Date(reading.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
                <div className="flex sm:flex-col gap-2 sm:text-right pl-11 sm:pl-0">
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
