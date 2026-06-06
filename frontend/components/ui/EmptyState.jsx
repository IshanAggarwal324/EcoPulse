import React from 'react';

const EmptyState = ({ icon, title, description }) => (
  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
    {icon && <div className="mb-4 text-slate-600 opacity-50">{icon}</div>}
    <p className="text-slate-400 font-medium">{title}</p>
    {description && <p className="text-slate-600 text-sm mt-1.5 max-w-sm">{description}</p>}
  </div>
);

export default EmptyState;
