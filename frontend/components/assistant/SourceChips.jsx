import React from 'react';
import {
  FileText,
  BarChart3,
  LineChart,
  Wallet,
  Leaf,
  ArrowLeftRight,
  Sun,
  Receipt,
} from 'lucide-react';

const TYPE_ICON = {
  analytics: BarChart3,
  doc: FileText,
  reading: BarChart3,
  forecast: LineChart,
  wallet: Wallet,
  carbon: Leaf,
  trade: ArrowLeftRight,
  nodes: Sun,
  bill: Receipt,
};

const TYPE_STYLE = {
  analytics:
    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20',
  reading:
    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20',
  forecast:
    'bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/20',
  wallet:
    'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20',
  carbon:
    'bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/20',
  trade:
    'bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/20',
  nodes:
    'bg-orange-500/10 text-orange-400 border-orange-500/20 hover:bg-orange-500/20',
  bill:
    'bg-rose-500/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20',
  doc: 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20',
};

const SourceChips = ({ sources }) => {
  if (!sources?.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {sources.map((src, i) => {
        const Icon = TYPE_ICON[src.type] || FileText;
        const style = TYPE_STYLE[src.type] || TYPE_STYLE.doc;
        return (
          <span
            key={`${src.label}-${i}`}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${style}`}
          >
            <Icon size={11} />
            {src.label}
          </span>
        );
      })}
    </div>
  );
};

export default React.memo(SourceChips);
