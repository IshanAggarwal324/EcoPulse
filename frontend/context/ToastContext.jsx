import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

const ToastActionsContext = createContext(null);

let toastId = 0;

const ICONS = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

const STYLES = {
  success: 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
  error: 'border-rose-500/40 bg-rose-950/90 text-rose-100',
  info: 'border-blue-500/40 bg-blue-950/90 text-blue-100',
};

function ToastViewport({ toasts, onDismiss }) {
  return (
    <div
      className="fixed z-[100] flex flex-col gap-2 pointer-events-none px-4 sm:px-0"
      style={{
        top: 'max(1rem, env(safe-area-inset-top))',
        right: 'max(1rem, env(safe-area-inset-right))',
        left: 'max(1rem, env(safe-area-inset-left))',
      }}
      aria-live="polite"
      aria-label="Notifications"
    >
      <div className="flex flex-col gap-2 sm:ml-auto sm:max-w-sm w-full sm:w-auto pointer-events-auto">
        {toasts.map((t) => {
          const Icon = ICONS[t.type] || Info;
          return (
            <div
              key={t.id}
              role="alert"
              className={`toast-enter flex items-start gap-3 p-4 rounded-xl border shadow-lg backdrop-blur-md ${STYLES[t.type]}`}
            >
              <Icon size={20} className="flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium flex-1 leading-snug">{t.message}</p>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                className="flex-shrink-0 p-1 rounded-md opacity-70 hover:opacity-100 transition-opacity min-h-[44px] min-w-[44px] flex items-center justify-center -m-2"
                aria-label="Dismiss"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message, options = {}) => {
    const { type = 'info', duration = 4000 } = options;
    const id = ++toastId;

    setToasts((prev) => [...prev, { id, message, type }].slice(-5));

    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }

    return id;
  }, [dismiss]);

  const success = useCallback((msg, opts) => toast(msg, { ...opts, type: 'success' }), [toast]);
  const error = useCallback((msg, opts) => toast(msg, { ...opts, type: 'error', duration: 5000 }), [toast]);
  const info = useCallback((msg, opts) => toast(msg, { ...opts, type: 'info' }), [toast]);

  const actions = useMemo(
    () => ({ toast, success, error, info, dismiss }),
    [toast, success, error, info, dismiss],
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastActionsContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastActionsContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};
