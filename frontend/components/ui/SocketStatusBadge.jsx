import React, { memo } from 'react';
import { RefreshCw } from 'lucide-react';
import { useSocketApi, useSocketStatus } from '../../context/SocketContext';

const STATUS_STYLES = {
  connected: {
    wrapper: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20',
    dot: 'bg-emerald-400 animate-pulse',
    label: 'Live Sync',
  },
  reconnecting: {
    wrapper: 'text-amber-400 bg-amber-400/10 border-amber-500/20',
    dot: 'bg-amber-400 animate-pulse',
    label: 'Reconnecting',
  },
  disconnected: {
    wrapper: 'text-slate-400 bg-slate-700/50 border-slate-600/30',
    dot: 'bg-slate-500',
    label: 'Offline',
  },
  failed: {
    wrapper: 'text-rose-400 bg-rose-400/10 border-rose-500/20',
    dot: 'bg-rose-500',
    label: 'Connection failed',
  },
};

const SocketStatusBadge = memo(function SocketStatusBadge({ className = '' }) {
  const { reconnect } = useSocketApi();
  const {
    status,
    reconnecting,
    reconnectAttempt,
    lastError,
  } = useSocketStatus();

  const styles = STATUS_STYLES[status] || STATUS_STYLES.disconnected;
  const showRetry = status === 'failed' || status === 'disconnected';

  return (
    <div className={`flex flex-col items-end gap-2 ${className}`}>
      <span className={`flex items-center gap-2 text-xs sm:text-sm px-3 py-1 rounded-full border ${styles.wrapper}`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${styles.dot}`} />
        {styles.label}
        {reconnecting && reconnectAttempt > 0 && (
          <span className="text-[10px] opacity-80">({reconnectAttempt})</span>
        )}
      </span>
      {showRetry && (
        <button
          type="button"
          onClick={reconnect}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          title={lastError || 'Retry connection'}
        >
          <RefreshCw size={12} />
          Retry
        </button>
      )}
    </div>
  );
});

export default SocketStatusBadge;
