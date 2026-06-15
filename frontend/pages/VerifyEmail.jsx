import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { authApi } from '../utils/api';

const VerifyEmail = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState(token ? 'loading' : 'missing');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;

    const verify = async () => {
      try {
        const data = await authApi.verifyEmail(token);
        if (cancelled) return;
        setStatus('success');
        setMessage(data.message || 'Email verified successfully.');
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setMessage(error.message || 'Verification failed.');
      }
    };

    verify();

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-slate-900 px-4 gap-4">
      {status === 'loading' && (
        <>
          <Loader2 className="h-10 w-10 text-emerald-500 animate-spin" />
          <p className="text-slate-400 text-sm">Verifying your email...</p>
        </>
      )}

      {status === 'success' && (
        <>
          <CheckCircle className="h-12 w-12 text-emerald-400" />
          <h1 className="text-xl font-bold text-white">Email verified</h1>
          <p className="text-slate-400 text-sm text-center max-w-md">{message}</p>
          <Link
            to="/"
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
          >
            Continue to dashboard
          </Link>
        </>
      )}

      {(status === 'error' || status === 'missing') && (
        <>
          <AlertCircle className="h-12 w-12 text-rose-400" />
          <h1 className="text-xl font-bold text-white">
            {status === 'missing' ? 'Invalid verification link' : 'Verification failed'}
          </h1>
          <p className="text-slate-400 text-sm text-center max-w-md">
            {status === 'missing'
              ? 'This link is missing a verification token. Check your email for the correct link.'
              : message}
          </p>
          <Link
            to="/settings"
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium"
          >
            Go to settings
          </Link>
        </>
      )}
    </div>
  );
};

export default VerifyEmail;
