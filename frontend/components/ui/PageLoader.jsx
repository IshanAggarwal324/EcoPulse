import React from 'react';
import { Loader2 } from 'lucide-react';

const PageLoader = ({ message = 'Loading...' }) => (
  <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-slate-400">
    <Loader2 className="h-10 w-10 text-emerald-500 animate-spin" />
    <p className="text-sm">{message}</p>
  </div>
);

export default PageLoader;
