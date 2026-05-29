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
    <div className="space-y-4 mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <Filter size={16} className="text-slate-500 shrink-0" />
        {DIRECTION_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onFilterChange(option.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filterId === option.id
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-slate-900/60 text-slate-400 border border-slate-700/50 hover:text-slate-200'
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
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              periodDays === option.days
                ? 'bg-slate-600 text-white'
                : 'bg-slate-900/60 text-slate-400 border border-slate-700/50 hover:text-slate-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Order / listing ID</label>
          <input
            type="number"
            min="0"
            value={listingId}
            onChange={(e) => onListingIdChange(e.target.value)}
            placeholder="e.g. 3"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Min price (CC)</label>
          <input
            type="number"
            min="0"
            step="any"
            value={minPrice}
            onChange={(e) => onMinPriceChange(e.target.value)}
            placeholder="0"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Max price (CC)</label>
          <input
            type="number"
            min="0"
            step="any"
            value={maxPrice}
            onChange={(e) => onMaxPriceChange(e.target.value)}
            placeholder="Any"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {hasAdvanced && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
        >
          <X size={14} />
          Clear filters
        </button>
      )}
    </div>
  );
};

export default TransactionFilters;
