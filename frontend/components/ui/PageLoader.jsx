import React from 'react';
import { Loader2 } from 'lucide-react';

const PageLoader = ({ message = 'Loading...' }) => (
  <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 text-slate-400">
    <div className="relative">
      <div className="absolute inset-0 bg-emerald-500/20 rounded-full blur-xl animate-pulse" />
      <Loader2 className="relative h-10 w-10 text-emerald-500 animate-spin" />
    </div>
    <p className="text-sm">{message}</p>
  </div>
);

export default PageLoader;
