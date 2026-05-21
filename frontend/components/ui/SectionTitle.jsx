import React from 'react';

const SectionTitle = ({ title, subtitle, action }) => {
  return (
    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-white mb-1">{title}</h2>
        {subtitle && <p className="text-slate-400 text-sm">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </header>
  );
};

export default SectionTitle;
