import React, { memo } from 'react';
import StatusCard from '../ui/StatusCard';

const DashboardNodePanel = memo(function DashboardNodePanel({ nodeStatus }) {
  return (
    <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-xl">
      <h3 className="text-xl font-bold text-white mb-6">Node Status</h3>
      <div className="space-y-4">
        {nodeStatus.length === 0 ? (
          <p className="text-slate-500 text-sm">No nodes registered. Create nodes via the API or simulator.</p>
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
