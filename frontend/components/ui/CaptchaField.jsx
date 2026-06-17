import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import {
  getCaptchaProvider,
  getCaptchaSiteKey,
  getRecaptchaVersion,
  loadCaptchaScript,
} from '../../utils/captcha';

const CaptchaField = forwardRef(({ onTokenChange, onError, resetKey = 0, disabled = false }, ref) => {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const mountId = useId().replace(/:/g, '');
  const [loadError, setLoadError] = useState('');

  const provider = getCaptchaProvider();
  const siteKey = getCaptchaSiteKey(provider);
  const recaptchaVersion = getRecaptchaVersion();
  const isRecaptchaV3 = provider === 'recaptcha' && recaptchaVersion === 'v3';

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenChange?.('');
      if (provider === 'turnstile' && widgetIdRef.current != null && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
      if (provider === 'hcaptcha' && widgetIdRef.current != null && window.hcaptcha) {
        window.hcaptcha.reset(widgetIdRef.current);
      }
      if (provider === 'recaptcha' && recaptchaVersion === 'v2' && widgetIdRef.current != null && window.grecaptcha) {
        window.grecaptcha.reset(widgetIdRef.current);
      }
    },
  }));

  useEffect(() => {
    if (isRecaptchaV3) {
      return undefined;
    }

    onTokenChange?.('');
    onError?.('');
    setLoadError('');
    widgetIdRef.current = null;

    if (!provider || !siteKey) {
      return undefined;
    }

    let cancelled = false;

    const mountWidget = async () => {
      try {
        await loadCaptchaScript(provider, recaptchaVersion, siteKey);
        if (cancelled || !containerRef.current) return;

        if (provider === 'turnstile' && window.turnstile) {
          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: (token) => {
              onTokenChange?.(token);
              onError?.('');
            },
            'expired-callback': () => onTokenChange?.(''),
            'error-callback': () => {
              onTokenChange?.('');
              onError?.('CAPTCHA verification failed. Please try again.');
            },
          });
          return;
        }

        if (provider === 'hcaptcha' && window.hcaptcha) {
          widgetIdRef.current = window.hcaptcha.render(containerRef.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: (token) => {
              onTokenChange?.(token);
              onError?.('');
            },
            'expired-callback': () => onTokenChange?.(''),
            'error-callback': () => {
              onTokenChange?.('');
              onError?.('CAPTCHA verification failed. Please try again.');
            },
          });
          return;
        }

        if (provider === 'recaptcha' && window.grecaptcha) {
          widgetIdRef.current = window.grecaptcha.render(containerRef.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: (token) => {
              onTokenChange?.(token);
              onError?.('');
            },
            'expired-callback': () => onTokenChange?.(''),
            'error-callback': () => {
              onTokenChange?.('');
              onError?.('CAPTCHA verification failed. Please try again.');
            },
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error?.message || 'Failed to load CAPTCHA';
          setLoadError(message);
          onError?.(message);
        }
      }
    };

    mountWidget();

    return () => {
      cancelled = true;
      onTokenChange?.('');

      if (provider === 'turnstile' && widgetIdRef.current != null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      if (provider === 'hcaptcha' && widgetIdRef.current != null && window.hcaptcha) {
        window.hcaptcha.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, [provider, siteKey, recaptchaVersion, resetKey, onTokenChange, onError, isRecaptchaV3]);

  if (!provider || !siteKey) {
    return null;
  }

  if (isRecaptchaV3) {
    return (
      <p className="text-xs text-slate-400">
        This form is protected by reCAPTCHA v3. Google&apos;s{' '}
        <a href="https://policies.google.com/privacy" className="text-emerald-400 hover:underline" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>{' '}
        and{' '}
        <a href="https://policies.google.com/terms" className="text-emerald-400 hover:underline" target="_blank" rel="noreferrer">
          Terms of Service
        </a>{' '}
        apply.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div
        id={`captcha-${mountId}`}
        ref={containerRef}
        className={`min-h-[65px] flex items-center ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        aria-live="polite"
      />
      {loadError && (
        <p className="text-sm text-rose-400 flex items-center gap-1.5">{loadError}</p>
      )}
    </div>
  );
});

CaptchaField.displayName = 'CaptchaField';

export default CaptchaField;
