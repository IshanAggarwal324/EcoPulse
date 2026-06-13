const ELLIPSIS = '\u2026';
const DASH = '\u2014';

export const shortWallet = (addr) => {
  if (!addr) return DASH;
  const s = String(addr);
  return s.length <= 12 ? s : `${s.slice(0, 6)}${ELLIPSIS}${s.slice(-4)}`;
};

export const formatDate = (d) => {
  if (!d) return DASH;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const formatDateTime = (d) => {
  if (!d) return DASH;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const timeAgo = (d) => {
  if (!d) return DASH;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return DASH;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
};

export const EXPLORERS = {
  11155111: 'https://sepolia.etherscan.io',
  1: 'https://etherscan.io',
};

export const explorerTxUrl = (chainId, txHash) => {
  if (!txHash) return null;
  const base = EXPLORERS[Number(chainId)];
  if (!base) return null;
  return `${base}/tx/${txHash}`;
};

export const explorerAddressUrl = (chainId, address) => {
  if (!address) return null;
  const base = EXPLORERS[Number(chainId)];
  if (!base) return null;
  return `${base}/address/${address}`;
};

const BASE_PILL = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border';

export const STATUS_PILL_CLASSES = {
  active: `${BASE_PILL} bg-emerald-500/10 border-emerald-500/30 text-emerald-400`,
  inactive: `${BASE_PILL} bg-slate-500/10 border-slate-500/30 text-slate-400`,
  maintenance: `${BASE_PILL} bg-amber-500/10 border-amber-500/30 text-amber-400`,
  failed: `${BASE_PILL} bg-rose-500/10 border-rose-500/30 text-rose-400`,
  listed: `${BASE_PILL} bg-blue-500/10 border-blue-500/30 text-blue-400`,
  purchased: `${BASE_PILL} bg-emerald-500/10 border-emerald-500/30 text-emerald-400`,
  cancelled: `${BASE_PILL} bg-slate-500/10 border-slate-500/30 text-slate-400`,
  pending: `${BASE_PILL} bg-amber-500/10 border-amber-500/30 text-amber-400`,
  sent: `${BASE_PILL} bg-emerald-500/10 border-emerald-500/30 text-emerald-400`,
};

export const StatusPill = ({ value, label }) => {
  const cls = STATUS_PILL_CLASSES[value] || `${BASE_PILL} bg-slate-500/10 border-slate-500/30 text-slate-400`;
  return <span className={cls}>{label || value}</span>;
};

export const PERIOD_LABELS = { '7d': '7 Days', '14d': '14 Days', '30d': '30 Days' };
export const SCOPE_LABELS = { personal: 'Personal', grid: 'Grid', both: 'Both' };
export const DELIVERY_LABELS = { chat: 'Chat', email: 'Email' };

export const NODE_TYPE_LABELS = { producer: 'Producer', consumer: 'Consumer', prosumer: 'Prosumer' };
export const SOURCE_TYPE_LABELS = {
  solar: 'Solar', wind: 'Wind', home: 'Home', industry: 'Industry', other: 'Other',
};
