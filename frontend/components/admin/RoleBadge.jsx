import React, { memo } from 'react';
import { ShieldCheck, Eye } from 'lucide-react';

const STYLES = {
  admin: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  moderator: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  user: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

const RoleBadge = memo(function RoleBadge({ role, className = '' }) {
  const normalized = (role || 'user').toLowerCase();
  const Icon = normalized === 'admin' ? ShieldCheck : Eye;
  const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold tracking-wide ${STYLES[normalized] || STYLES.user} ${className}`}
    >
      <Icon size={12} />
      {label}
    </span>
  );
});

export default RoleBadge;
