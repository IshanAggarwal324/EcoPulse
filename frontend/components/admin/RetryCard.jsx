import React, { memo } from 'react';
import { RefreshCw } from 'lucide-react';

const RetryCard = memo(function RetryCard({ message = 'Something went wrong', onRetry }) {
  return (
    <div className="content-card">
      <div className="flex flex-col items-center justify-center py-14 px-6 text-center animate-fade-in-up">
        <p className="text-slate-300 font-semibold text-lg mb-1.5">Couldn’t load data</p>
        <p className="text-slate-500 text-sm max-w-xs leading-relaxed mb-5">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 rounded-xl text-sm font-medium transition-colors"
        >
          <RefreshCw size={15} /> Try again
        </button>
      </div>
    </div>
  );
});

export default RetryCard;
