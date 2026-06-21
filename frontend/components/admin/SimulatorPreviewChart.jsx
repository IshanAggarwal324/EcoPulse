import React, { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

const Chart = lazy(() => import('./SimulatorPreviewChartInner'));

export default function SimulatorPreviewChart({ data }) {
  if (!data?.length) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        No preview data
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-slate-500 gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading chart…</span>
        </div>
      }
    >
      <Chart data={data} />
    </Suspense>
  );
}
