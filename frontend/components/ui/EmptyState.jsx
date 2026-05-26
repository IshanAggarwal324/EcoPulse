import React from 'react';

const EmptyState = ({ icon, title, description }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
    {icon && <div className="mb-4 text-slate-500">{icon}</div>}
    <p className="text-slate-300 font-medium">{title}</p>
    {description && <p className="text-slate-500 text-sm mt-1 max-w-sm">{description}</p>}
  </div>
);

export default EmptyState;
