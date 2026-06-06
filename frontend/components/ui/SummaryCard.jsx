import React, { memo } from 'react';

const SummaryCard = memo(function SummaryCard({ label, value, icon, trend, positive }) {
  return (
    <div className="glass-card rounded-2xl p-5 sm:p-6 card-hover-glow glow-emerald animate-fade-in-up">
      <div className="flex justify-between items-start gap-2 mb-4">
        <div className="p-2.5 sm:p-3 bg-slate-900/80 rounded-xl border border-slate-700/50 flex-shrink-0">
          {icon}
        </div>
        <span
          className={`text-xs sm:text-sm font-medium px-2.5 py-1 rounded-lg text-right max-w-[50%] truncate backdrop-blur-sm ${
            positive
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
          }`}
        >
          {trend}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-slate-500 text-xs sm:text-sm font-medium mb-1 truncate uppercase tracking-wider">{label}</p>
        <h3 className="text-xl sm:text-2xl lg:text-3xl font-bold text-white tracking-tight break-words">
          {value}
        </h3>
      </div>
    </div>
  );
});

export default SummaryCard;
