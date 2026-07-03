import React, { memo } from 'react';
import { ShieldCheck, Eye, Zap, Radio, Users as UsersIcon } from 'lucide-react';

const STYLES = {
  admin: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  moderator: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  prosumer: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  grid_operator: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  consumer: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

const ICONS = {
  admin: ShieldCheck,
  moderator: UsersIcon,
  prosumer: Zap,
  grid_operator: Radio,
  consumer: Eye,
};

const LABELS = {
  grid_operator: 'Grid Operator',
};

const RoleBadge = memo(function RoleBadge({ role, className = '' }) {
  const normalized = (role || 'consumer').toLowerCase();
  const Icon = ICONS[normalized] || Eye;
  const fallbackLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  const label = LABELS[normalized] || fallbackLabel;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold tracking-wide ${STYLES[normalized] || STYLES.consumer} ${className}`}
    >
      <Icon size={12} />
      {label}
    </span>
  );
});

export default RoleBadge;
