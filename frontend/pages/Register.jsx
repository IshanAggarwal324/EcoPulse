import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { UserPlus } from 'lucide-react';
import FormField from '../components/ui/FormField';
import CaptchaField from '../components/ui/CaptchaField';
import { validateRegisterForm, hasErrors } from '../utils/validation';
import { useToast } from '../context/ToastContext';
import { authApi } from '../utils/api';
import {
  executeRecaptchaV3,
  getCaptchaProvider,
  getCaptchaSiteKey,
  getRecaptchaVersion,
  isCaptchaConfiguredLocally,
} from '../utils/captcha';
import logo from '../../ecopulse/src/assets/logo.png';

const Register = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [captchaError, setCaptchaError] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaRequired, setCaptchaRequired] = useState(false);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const captchaRef = useRef(null);
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const localCaptchaProvider = getCaptchaProvider();
  const localCaptchaSiteKey = getCaptchaSiteKey(localCaptchaProvider);
  const isRecaptchaV3 = localCaptchaProvider === 'recaptcha' && getRecaptchaVersion() === 'v3';

  useEffect(() => {
    let cancelled = false;

    const loadCaptchaConfig = async () => {
      try {
        const data = await authApi.getCaptchaConfig();
        if (!cancelled) {
          setCaptchaRequired(Boolean(data?.captcha?.required));
        }
      } catch {
        if (!cancelled) {
          setCaptchaRequired(false);
        }
      }
    };

    loadCaptchaConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (fieldErrors[name]) {
      setFieldErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const resetCaptcha = () => {
    setCaptchaToken('');
    setCaptchaError('');
    captchaRef.current?.reset?.();
    setCaptchaResetKey((key) => key + 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setCaptchaError('');

    const errors = validateRegisterForm(formData);
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    if (captchaRequired && !isCaptchaConfiguredLocally()) {
      const message =
        'Registration CAPTCHA is enabled on the server but the frontend site key is missing. Set VITE_CAPTCHA_PROVIDER and the matching VITE_*_SITE_KEY in Vercel.';
      setFormError(message);
      toast.error(message);
      return;
    }

    let token = captchaToken;

    if (captchaRequired && isRecaptchaV3) {
      try {
        token = await executeRecaptchaV3(localCaptchaSiteKey);
      } catch {
        const message = 'CAPTCHA verification failed. Please try again.';
        setCaptchaError(message);
        toast.error(message);
        return;
      }
    }

    if (captchaRequired && !token) {
      const message = 'Please complete the CAPTCHA verification.';
      setCaptchaError(message);
      toast.error(message);
      return;
    }

    setIsSubmitting(true);

    const { confirmPassword, ...registerData } = formData;
    const payload = {
      ...registerData,
      name: registerData.name.trim(),
      email: registerData.email.trim(),
      ...(token ? { captchaToken: token } : {}),
    };

    const result = await register(payload);

    if (result.success) {
      if (result.requiresLogin) {
        toast.info(result.message || 'Registration complete. Please sign in.');
        navigate('/login', { replace: true });
      } else {
        toast.success('Account created successfully!');
        navigate('/', { replace: true });
      }
    } else {
      setFormError(result.message);
      toast.error(result.message);
      if (Array.isArray(result.errors)) {
        const serverErrors = {};
        result.errors.forEach((msg) => {
          if (msg.toLowerCase().includes('email')) serverErrors.email = msg;
          else if (msg.toLowerCase().includes('password')) serverErrors.password = msg;
          else if (msg.toLowerCase().includes('name')) serverErrors.name = msg;
        });
        setFieldErrors((prev) => ({ ...prev, ...serverErrors }));
      }
      if (
        result.code === 'CAPTCHA_REQUIRED'
        || result.code === 'CAPTCHA_FAILED'
        || result.code === 'CAPTCHA_ERROR'
        || /captcha/i.test(result.message || '')
      ) {
        resetCaptcha();
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-slate-950 flex flex-col justify-center py-8 px-4 sm:py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      <div className="absolute inset-0 ambient-bg" />
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl" />
      <div className="absolute bottom-1/3 left-1/4 w-80 h-80 bg-blue-500/5 rounded-full blur-3xl" />

      <div className="relative z-10 sm:mx-auto sm:w-full sm:max-w-md animate-fade-in-up">
        <div className="flex justify-center">
          <div className="p-3 rounded-2xl bg-slate-800/40 backdrop-blur-xl border border-slate-700/30">
            <img src={logo} alt="EcoPulse Logo" className="h-16 w-auto" />
          </div>
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-white">Join EcoPulse</h2>
        <p className="mt-2 text-center text-sm text-slate-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-emerald-400 hover:text-emerald-300 transition-colors">
            Sign in
          </Link>
        </p>
      </div>

      <div className="relative z-10 mt-8 sm:mx-auto sm:w-full sm:max-w-md animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
        <div className="bg-slate-800/60 backdrop-blur-2xl py-8 px-4 shadow-2xl shadow-black/20 sm:rounded-2xl sm:px-10 border border-slate-700/40">
          {formError && (
            <div className="mb-5 bg-rose-500/10 border border-rose-500/30 rounded-xl p-4">
              <p className="text-sm text-rose-300">{formError}</p>
            </div>
          )}

          <form className="space-y-5" onSubmit={handleSubmit} noValidate>
            <FormField
              label="Full name"
              id="name"
              value={formData.name}
              onChange={handleChange}
              error={fieldErrors.name}
              required
              autoComplete="name"
            />

            <FormField
              label="Email address"
              id="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              error={fieldErrors.email}
              required
              autoComplete="email"
            />

            <FormField
              label="Password"
              id="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              error={fieldErrors.password}
              required
              autoComplete="new-password"
              maxLength={128}
              hint="8–128 characters, with an uppercase letter and number"
            />

            <FormField
              label="Confirm password"
              id="confirmPassword"
              type="password"
              value={formData.confirmPassword}
              onChange={handleChange}
              error={fieldErrors.confirmPassword}
              required
              autoComplete="new-password"
              maxLength={128}
            />

            {captchaRequired && isCaptchaConfiguredLocally() && (
              <div className="space-y-2">
                <CaptchaField
                  ref={captchaRef}
                  resetKey={captchaResetKey}
                  disabled={isSubmitting}
                  onTokenChange={setCaptchaToken}
                  onError={setCaptchaError}
                />
                {captchaError && (
                  <p className="text-sm text-rose-400">{captchaError}</p>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex justify-center items-center py-3 px-4 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50 transition-all duration-200 shadow-lg shadow-emerald-500/20"
            >
              {isSubmitting ? 'Creating account...' : 'Create account'}
              {!isSubmitting && <UserPlus className="ml-2 h-4 w-4" />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Register;
