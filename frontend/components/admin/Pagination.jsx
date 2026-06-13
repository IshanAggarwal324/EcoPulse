import React, { memo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const Pagination = memo(function Pagination({ page, pages, total, onChange, loading }) {
  if (!pages || pages <= 1) return null;

  const safePage = page || 1;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, safePage - 1))}
        disabled={safePage <= 1 || loading}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronLeft size={14} /> Prev
      </button>
      <p className="text-xs text-slate-500">
        {total != null && (
          <>
            <span className="text-slate-300 font-medium">{total}</span> {total === 1 ? 'item' : 'items'} ·{' '}
          </>
        )}
        Page <span className="text-slate-300 font-medium">{safePage}</span> of{' '}
        <span className="text-slate-300 font-medium">{pages}</span>
      </p>
      <button
        type="button"
        onClick={() => onChange(Math.min(pages, safePage + 1))}
        disabled={safePage >= pages || loading}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Next <ChevronRight size={14} />
      </button>
    </div>
  );
});

export default Pagination;
