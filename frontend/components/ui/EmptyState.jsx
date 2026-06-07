import React from 'react';
import { Link } from 'react-router-dom';

const ILLUSTRATIONS = {
  default: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <rect x="16" y="24" width="48" height="36" rx="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
      <circle cx="40" cy="42" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M37 42l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="28" cy="32" r="2" fill="currentColor" opacity="0.3" />
      <circle cx="52" cy="32" r="2" fill="currentColor" opacity="0.3" />
    </svg>
  ),
  trading: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <rect x="12" y="28" width="24" height="28" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M20 40h8M20 44h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="44" y="28" width="24" height="28" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M52 40h8M52 44h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M36 42h8" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      <circle cx="40" cy="42" r="2" fill="currentColor" />
    </svg>
  ),
  energy: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <path d="M44 16L28 42h12L36 64l20-30H44L56 16H44z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="24" cy="56" r="4" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <circle cx="56" cy="24" r="3" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <circle cx="60" cy="52" r="2.5" stroke="currentColor" strokeWidth="1" opacity="0.3" />
    </svg>
  ),
  credits: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <circle cx="40" cy="40" r="18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="40" cy="40" r="12" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
      <path d="M40 30v20M35 35h10M35 40h10M35 45h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="62" cy="22" r="4" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <circle cx="18" cy="58" r="3" stroke="currentColor" strokeWidth="1" opacity="0.3" />
    </svg>
  ),
  nodes: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <circle cx="40" cy="28" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="24" cy="56" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="56" cy="56" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M35 34L27 52M45 34l9 18M30 56h20" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" />
    </svg>
  ),
  transactions: (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="animate-float">
      <rect x="16" y="20" width="48" height="40" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 30h48" stroke="currentColor" strokeWidth="1" />
      <circle cx="24" cy="25" r="2" fill="currentColor" opacity="0.4" />
      <circle cx="30" cy="25" r="2" fill="currentColor" opacity="0.3" />
      <path d="M24 38h20M24 44h16M24 50h24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  ),
};

const EmptyState = ({ icon, title, description, illustration, actionTo, actionLabel }) => {
  const svg = illustration && ILLUSTRATIONS[illustration]
    ? ILLUSTRATIONS[illustration]
    : icon
      ? <div className="opacity-40">{icon}</div>
      : ILLUSTRATIONS.default;

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center animate-fade-in-up">
      <div className="text-slate-600 mb-5">
        {svg}
      </div>
      <p className="text-slate-300 font-semibold text-lg mb-1.5">{title}</p>
      {description && <p className="text-slate-500 text-sm max-w-xs leading-relaxed">{description}</p>}
      {actionTo && actionLabel && (
        <Link
          to={actionTo}
          className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 rounded-xl text-sm font-medium transition-colors"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
};

export default EmptyState;
