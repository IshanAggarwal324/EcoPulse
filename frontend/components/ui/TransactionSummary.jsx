import React from 'react';

const Stat = ({ label, value, accent }) => (
  <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 min-w-0">
    <p className="text-xs text-slate-400 truncate">{label}</p>
    <p className={`text-lg font-bold mt-1 truncate ${accent || 'text-white'}`}>{value}</p>
  </div>
);

const TransactionSummary = ({ summary, wallet, compact = false }) => {
  if (!summary) return null;

  const showing = summary.showing ?? summary.total ?? 0;
  const matchTotal = summary.matchTotal ?? showing;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-3 text-sm text-slate-400 mb-4 p-3 bg-slate-900/40 rounded-xl border border-slate-700/40">
        <span>
          Showing <strong className="text-white">{showing}</strong>
          {matchTotal !== showing && ` of ${matchTotal}`} transactions
        </span>
        {summary.purchased > 0 && (
          <span>
            · <strong className="text-blue-300">{summary.purchased}</strong> purchases
          </span>
        )}
        {wallet && (
          <span>
            · Net{' '}
            <strong className={summary.netFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {summary.netFlow >= 0 ? '+' : ''}
              {(summary.netFlow || 0).toFixed(2)} CC
            </strong>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-6">
      <p className="text-xs text-slate-500 mb-3">
        Summary for current filters
        {matchTotal !== showing && ` · ${showing} shown of ${matchTotal} matching`}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Transactions" value={showing} />
        <Stat label="Listed" value={summary.listed ?? 0} accent="text-emerald-400" />
        <Stat label="Purchased" value={summary.purchased ?? 0} accent="text-blue-400" />
        <Stat label="Cancelled" value={summary.cancelled ?? 0} accent="text-amber-400" />
        <Stat
          label="Volume (CC)"
          value={(summary.totalVolumeCc ?? 0).toFixed(2)}
          accent="text-emerald-400"
        />
        {wallet ? (
          <Stat
            label="Net flow"
            value={`${(summary.netFlow || 0) >= 0 ? '+' : ''}${(summary.netFlow || 0).toFixed(2)}`}
            accent={(summary.netFlow || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          />
        ) : (
          <Stat
            label="Energy traded"
            value={`${(summary.totalEnergyTraded ?? 0).toLocaleString()} kWh`}
          />
        )}
      </div>
      {wallet && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
          <Stat
            label="Credits received"
            value={`${(summary.creditsReceived || 0).toFixed(2)} CC`}
            accent="text-emerald-400"
          />
          <Stat
            label="Credits spent"
            value={`${(summary.creditsSpent || 0).toFixed(2)} CC`}
            accent="text-rose-400"
          />
          <Stat
            label="Energy traded"
            value={`${(summary.totalEnergyTraded ?? 0).toLocaleString()} kWh`}
          />
        </div>
      )}
    </div>
  );
};

export default TransactionSummary;
