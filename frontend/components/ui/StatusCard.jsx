import React, { memo } from 'react';

const StatusCard = memo(function StatusCard({ name, type, status, output, icon }) {
  const isOptimal = status === 'Optimal';

  return (
    <div className="p-4 glass-card rounded-xl card-hover-glow">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-slate-800/80 rounded-lg border border-slate-700/30">
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="font-semibold text-slate-200 truncate">{name}</h4>
          <p className="text-[11px] text-slate-500">{type}</p>
        </div>
      </div>
      <div className="flex justify-between items-end">
        <div>
          <p className="text-[10px] text-slate-600 uppercase tracking-wider mb-0.5">Output</p>
          <p className="font-medium text-white text-sm">{output}</p>
        </div>
        <span className={`text-[11px] px-2.5 py-1 rounded-lg font-medium ${
          isOptimal
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-slate-800/60 text-slate-400 border border-slate-700/40'
        }`}>
          {status}
        </span>
      </div>
    </div>
  );
});

export default StatusCard;
