import React, { memo } from 'react';

const SectionTitle = memo(function SectionTitle({ title, subtitle, action }) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white mb-1 break-words">
          {title}
        </h2>
        {subtitle && (
          <p className="text-slate-400 text-sm leading-relaxed">{subtitle}</p>
        )}
      </div>
      {action && (
        <div className="flex-shrink-0 w-full sm:w-auto [&_button]:w-full sm:[&_button]:w-auto">
          {action}
        </div>
      )}
    </header>
  );
});

export default SectionTitle;
