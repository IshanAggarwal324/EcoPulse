import React from 'react';
import { Filter, X } from 'lucide-react';
import { DIRECTION_FILTERS, PERIOD_FILTERS } from '../../utils/transactionUtils';

const TransactionFilters = ({
  filterId,
  onFilterChange,
  periodDays,
  onPeriodChange,
  listingId,
  onListingIdChange,
  minPrice,
  onMinPriceChange,
  maxPrice,
  onMaxPriceChange,
  onClear,
}) => {
  const hasAdvanced =
    listingId || minPrice || maxPrice || periodDays;

  return (
    <div className="space-y-3 mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <Filter size={14} className="text-slate-600 shrink-0" />
        {DIRECTION_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onFilterChange(option.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
              filterId === option.id
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'bg-slate-900/40 text-slate-500 border border-slate-700/30 hover:text-slate-200 hover:border-slate-600/40'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {PERIOD_FILTERS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onPeriodChange(option.days)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
              periodDays === option.days
                ? 'bg-slate-600/60 text-white border border-slate-500/40'
                : 'bg-slate-900/40 text-slate-500 border border-slate-700/30 hover:text-slate-200 hover:border-slate-600/40'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div>
          <label className="block text-[10px] text-slate-600 mb-1 uppercase tracking-wider">Order / listing ID</label>
          <input
            type="number"
            min="0"
            value={listingId}
            onChange={(e) => onListingIdChange(e.target.value)}
            placeholder="e.g. 3"
            className="w-full bg-slate-900/40 border border-slate-700/30 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-600 mb-1 uppercase tracking-wider">Min price (CC)</label>
          <input
            type="number"
            min="0"
            step="any"
            value={minPrice}
            onChange={(e) => onMinPriceChange(e.target.value)}
            placeholder="0"
            className="w-full bg-slate-900/40 border border-slate-700/30 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-600 mb-1 uppercase tracking-wider">Max price (CC)</label>
          <input
            type="number"
            min="0"
            step="any"
            value={maxPrice}
            onChange={(e) => onMaxPriceChange(e.target.value)}
            placeholder="Any"
            className="w-full bg-slate-900/40 border border-slate-700/30 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
        </div>
      </div>

      {hasAdvanced && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-200 transition-colors"
        >
          <X size={14} />
          Clear filters
        </button>
      )}
    </div>
  );
};

export default TransactionFilters;
