import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { UserPlus } from 'lucide-react';
import FormField from '../components/ui/FormField';
import { validateRegisterForm, hasErrors } from '../utils/validation';
import logo from '../../ecopulse/src/assets/logo.png';

const Register = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    walletAddress: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (fieldErrors[name]) {
      setFieldErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const errors = validateRegisterForm(formData);
    setFieldErrors(errors);
    if (hasErrors(errors)) return;

    setIsSubmitting(true);

    const { confirmPassword, ...registerData } = formData;
    const payload = {
      ...registerData,
      name: registerData.name.trim(),
      email: registerData.email.trim(),
      walletAddress: registerData.walletAddress.trim() || undefined,
    };

    const result = await register(payload);

    if (result.success) {
      navigate('/', { replace: true });
    } else {
      setFormError(result.message);
      if (Array.isArray(result.errors)) {
        const serverErrors = {};
        result.errors.forEach((msg) => {
          if (msg.toLowerCase().includes('email')) serverErrors.email = msg;
          else if (msg.toLowerCase().includes('password')) serverErrors.password = msg;
          else if (msg.toLowerCase().includes('name')) serverErrors.name = msg;
        });
        setFieldErrors((prev) => ({ ...prev, ...serverErrors }));
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <img src={logo} alt="EcoPulse Logo" className="h-20 w-auto" />
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-white">Join EcoPulse</h2>
        <p className="mt-2 text-center text-sm text-slate-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-emerald-400 hover:text-emerald-300">
            Sign in
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-slate-800 py-8 px-4 shadow sm:rounded-lg sm:px-10 border border-slate-700">
          {formError && (
            <div className="mb-4 bg-rose-900/40 border border-rose-500/40 rounded-lg p-4">
              <p className="text-sm text-rose-200">{formError}</p>
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
              label="Wallet address"
              id="walletAddress"
              value={formData.walletAddress}
              onChange={handleChange}
              error={fieldErrors.walletAddress}
              placeholder="0x... (optional)"
              hint="Link your MetaMask wallet for carbon credit tracking"
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
              hint="At least 6 characters"
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
            />

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex justify-center items-center py-2.5 px-4 rounded-md text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 transition-colors"
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
