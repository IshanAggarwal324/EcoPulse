import React, { useEffect } from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';

const TONES = {
  danger: 'bg-rose-500/90 hover:bg-rose-500 text-white',
  default: 'bg-emerald-500/90 hover:bg-emerald-500 text-white',
};

const ConfirmDialog = ({
  open,
  title = 'Confirm action',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading = false,
  onClose,
  onConfirm,
  children,
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !loading) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

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
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-sm bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 id="confirm-dialog-title" className="text-sm font-semibold text-slate-100">{title}</h3>
          <button
            type="button"
            onClick={() => !loading && onClose?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-5">
          {tone === 'danger' && (
            <div className="flex items-start gap-3 mb-3">
              <div className="p-2 bg-rose-500/10 rounded-lg flex-shrink-0">
                <AlertTriangle size={18} className="text-rose-400" />
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
            </div>
          )}
          {tone !== 'danger' && (
            <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
          )}
          {children}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition-colors disabled:opacity-60 ${TONES[tone] || TONES.default}`}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default React.memo(ConfirmDialog);
