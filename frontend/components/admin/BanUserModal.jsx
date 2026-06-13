import React, { useState, useEffect } from 'react';
import { X, Ban, Loader2 } from 'lucide-react';

const BanUserModal = ({ open, user, loading, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open, user?._id]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !loading) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, onClose]);

  if (!open || !user) return null;

  const trimmed = reason.trim();
  const invalid = touched && trimmed.length === 0;

  const handleSubmit = (e) => {
    e?.preventDefault();
    setTouched(true);
    if (trimmed.length === 0) return;
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !loading && onClose?.()}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ban-modal-title"
        className="relative w-full max-w-md bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 id="ban-modal-title" className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Ban size={16} className="text-rose-400" />
            Ban user
          </h3>
          <button
            type="button"
            onClick={() => !loading && onClose?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 py-5">
          <p className="text-sm text-slate-300 mb-1">
            Banning <span className="font-semibold text-white">{user.name}</span>
          </p>
          <p className="text-xs text-slate-500 mb-4 truncate">{user.email}</p>

          <label htmlFor="banReason" className="block text-sm font-medium text-slate-300 mb-1.5">
            Reason <span className="text-rose-400">*</span>
          </label>
          <textarea
            id="banReason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={loading}
            rows={3}
            placeholder="e.g. Violated trading terms on multiple occasions"
            autoFocus
            className={`w-full px-3 py-2.5 bg-slate-950 border rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 transition-colors resize-none ${
              invalid
                ? 'border-rose-500/60 focus:ring-rose-500/30'
                : 'border-slate-700/60 focus:ring-emerald-500/40'
            }`}
          />
          {invalid && (
            <p className="text-xs text-rose-400 mt-1.5">A reason is required to ban this user.</p>
          )}

          <div className="flex items-center justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-rose-500/90 hover:bg-rose-500 text-white transition-colors disabled:opacity-60"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
              Ban user
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default React.memo(BanUserModal);
