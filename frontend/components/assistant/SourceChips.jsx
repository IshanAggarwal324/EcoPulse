import React from 'react';
import { FileText, BarChart3 } from 'lucide-react';

const TYPE_ICON = {
  analytics: BarChart3,
  doc: FileText,
};

const TYPE_STYLE = {
  analytics:
    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20',
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
