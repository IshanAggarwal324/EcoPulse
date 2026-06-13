import React, { memo } from 'react';
import { Wrench, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

const PHASE_LABELS = {
  'phase-4': 'Phase 4',
  'phase-5': 'Phase 5',
  'phase-6': 'Phase 6',
};

const AdminPlaceholder = memo(function AdminPlaceholder({
  title,
  description,
  features = [],
  phase = 'phase-4',
  backTo = '/admin',
  backLabel = 'Back to overview',
}) {
  return (
    <div className="page-section max-w-3xl mx-auto w-full">
      <div className="content-card">
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2.5 bg-emerald-500/10 rounded-xl">
            <Wrench className="text-emerald-400" size={22} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">{title}</h3>
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[11px] font-semibold tracking-wide">
              {PHASE_LABELS[phase] || 'Upcoming'} module
            </span>
          </div>
        </div>

        <p className="text-slate-400 text-sm leading-relaxed mb-6">{description}</p>

        {features.length > 0 && (
          <ul className="space-y-2.5 mb-6">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-2.5 text-sm text-slate-300">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                {feature}
              </li>
            ))}
          </ul>
        )}

        <Link
          to={backTo}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          <ArrowRight size={14} className="rotate-180" />
          {backLabel}
        </Link>
      </div>
    </div>
  );
});

export default AdminPlaceholder;
