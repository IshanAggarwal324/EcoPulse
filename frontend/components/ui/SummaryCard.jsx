import React from 'react';

const SummaryCard = ({ label, value, icon, trend, positive }) => {
  return (
    <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 shadow-lg hover:-translate-y-1 hover:shadow-xl hover:shadow-emerald-500/10 transition-all duration-300">
      <div className="flex justify-between items-start mb-4">
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-700">
          {icon}
        </div>
        <span className={`text-sm font-medium px-2.5 py-1 rounded-full ${positive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
          {trend}
        </span>
      </div>
      <div>
        <p className="text-slate-400 text-sm font-medium mb-1">{label}</p>
        <h3 className="text-3xl font-bold text-white tracking-tight">{value}</h3>
      </div>
    </div>
  );
};

export default SummaryCard;
