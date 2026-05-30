import React, { memo } from 'react';

const StatusCard = memo(function StatusCard({ name, type, status, output, icon }) {
  return (
    <div className="p-4 bg-slate-900/80 border border-slate-700 rounded-xl hover:border-slate-600 transition-colors">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-slate-800 rounded-lg">
          {icon}
        </div>
        <div>
          <h4 className="font-semibold text-slate-200">{name}</h4>
          <p className="text-xs text-slate-400">{type}</p>
        </div>
      </div>
      <div className="flex justify-between items-end">
        <div>
          <p className="text-xs text-slate-500 mb-0.5">Output</p>
          <p className="font-medium text-white">{output}</p>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300">
          {status}
        </span>
      </div>
    </div>
  );
});

export default StatusCard;
