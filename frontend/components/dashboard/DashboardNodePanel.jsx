import React, { memo } from 'react';
import StatusCard from '../ui/StatusCard';

const DashboardNodePanel = memo(function DashboardNodePanel({ nodeStatus }) {
  return (
    <div className="glass-card rounded-2xl p-5 sm:p-6 glow-emerald card-hover-glow">
      <div className="flex items-center gap-2 mb-5">
        <h3 className="text-lg sm:text-xl font-bold text-white">Node Status</h3>
        <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-700/40 text-slate-400 border border-slate-700/30">
          {nodeStatus.length} nodes
        </span>
      </div>
      <div className="space-y-3">
        {nodeStatus.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-slate-500 text-sm">No nodes registered</p>
            <p className="text-slate-600 text-xs mt-1">Create nodes via the API or simulator</p>
          </div>
        ) : (
          nodeStatus.map((node) => (
            <StatusCard key={node.name} {...node} />
          ))
        )}
      </div>
    </div>
  );
});

export default DashboardNodePanel;
