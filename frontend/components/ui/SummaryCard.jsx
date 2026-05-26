import React from 'react';

const SummaryCard = ({ label, value, icon, trend, positive }) => (
  <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-lg hover:shadow-xl hover:shadow-emerald-500/5 transition-shadow duration-300">
    <div className="flex justify-between items-start gap-2 mb-3 sm:mb-4">
      <div className="p-2.5 sm:p-3 bg-slate-900 rounded-xl border border-slate-700 flex-shrink-0">
        {icon}
      </div>
      <span
        className={`text-xs sm:text-sm font-medium px-2 py-1 rounded-full text-right max-w-[50%] truncate ${
          positive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
        }`}
      >
        {trend}
      </span>
    </div>
    <div className="min-w-0">
      <p className="text-slate-400 text-xs sm:text-sm font-medium mb-1 truncate">{label}</p>
      <h3 className="text-xl sm:text-2xl lg:text-3xl font-bold text-white tracking-tight break-words">
        {value}
      </h3>
    </div>
  </div>
);

export default SummaryCard;
