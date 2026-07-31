import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, SearchX } from 'lucide-react';

/**
 * Catch-all route target.
 *
 * Without this, an unmatched URL rendered the app chrome around an empty
 * content area, which is indistinguishable from a crashed page. `homeTo` lets
 * the admin route group point "back" at the admin root instead of the user
 * dashboard.
 */
const NotFound = ({ homeTo = '/', homeLabel = 'Back to dashboard' }) => {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <main
      role="main"
      aria-labelledby="notfound-title"
      className="flex flex-col items-center justify-center py-20 px-6 text-center animate-fade-in-up"
    >
      <div className="relative mb-6 text-slate-600">
        <div className="absolute inset-0 bg-emerald-500/10 rounded-full blur-2xl" aria-hidden="true" />
        <SearchX className="relative h-16 w-16 text-emerald-500/70" aria-hidden="true" />
      </div>

      <p className="text-emerald-400/80 text-sm font-semibold tracking-widest mb-2">404</p>
      <h1 id="notfound-title" className="text-slate-200 font-semibold text-2xl mb-2">
        Page not found
      </h1>
      <p className="text-slate-500 text-sm max-w-sm leading-relaxed">
        We couldn&apos;t find anything at{' '}
        <code className="text-slate-400 bg-slate-800/60 px-1.5 py-0.5 rounded break-all">
          {location.pathname}
        </code>
        . The link may be outdated, or the page may have moved.
      </p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Link
          to={homeTo}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none rounded-xl text-sm font-medium transition-colors"
        >
          <Compass className="h-4 w-4" aria-hidden="true" />
          {homeLabel}
        </Link>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-800/60 text-slate-300 border border-slate-700 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none rounded-xl text-sm font-medium transition-colors"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Go back
        </button>
      </div>
    </main>
  );
};

export default NotFound;
