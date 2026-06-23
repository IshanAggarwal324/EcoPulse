import React, { useState } from 'react';
import { Mail, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { authApi } from '../utils/api';

const EmailVerificationBanner = () => {
  const { user } = useAuth();
  const toast = useToast();
  const [sending, setSending] = useState(false);

  if (!user || user.isEmailVerified) {
    return null;
  }

  const handleResend = async () => {
    setSending(true);
    try {
      const result = await authApi.resendVerification();
      const status = result?.status;
      const message = result?.message || 'Verification email request completed.';

      if (status === 'sent') {
        toast.success(message);
      } else if (status === 'already_verified') {
        toast.info(message);
      } else if (status === 'not_configured' || status === 'send_failed') {
        toast.error(message);
      } else {
        toast.info(message);
      }
    } catch (error) {
      toast.error(error.message || 'Failed to send verification email.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-start gap-3 flex-1">
        <Mail className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-amber-100 text-sm font-medium">Verify your email address</p>
          <p className="text-amber-200/80 text-xs mt-0.5">
            Some features are limited until you verify {user.email}.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleResend}
        disabled={sending}
        className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs font-medium"
      >
        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Resend email
      </button>
    </div>
  );
};

export default EmailVerificationBanner;
