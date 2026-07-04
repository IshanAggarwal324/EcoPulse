import React, { useState, useEffect } from 'react';
import { User, Lock, Bell, Save, AlertCircle, Activity } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import FormField from '../components/ui/FormField';
import WalletLinkCard from '../components/settings/WalletLinkCard';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { anomalyApi } from '../utils/api';
import {
  validateName,
  validatePassword,
  validatePasswordStrength,
} from '../utils/validation';

const Settings = () => {
  const { user, updateProfile, updatePassword, logout } = useAuth();
  const toast = useToast();

  const [profile, setProfile] = useState({
    name: '',
    emailNotifications: true,
    gridAlerts: true,
    energyUnit: 'kWh',
  });

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const [profileErrors, setProfileErrors] = useState({});
  const [passwordErrors, setPasswordErrors] = useState({});
  const [profileError, setProfileError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const [anomalies, setAnomalies] = useState([]);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);
  const [anomaliesError, setAnomaliesError] = useState('');

  useEffect(() => {
    if (user) {
      setProfile({
        name: user.name || '',
        emailNotifications: user.preferences?.emailNotifications ?? true,
        gridAlerts: user.preferences?.gridAlerts ?? true,
        energyUnit: user.preferences?.energyUnit || 'kWh',
      });
    }
  }, [user]);

  // Module 4.1 — ML meter-anomaly feed. Only loaded when the user has opted
  // into grid alerts. Failures are non-fatal (shown inline, never crash the page).
  useEffect(() => {
    let cancelled = false;
    async function loadAnomalies() {
      if (!user || !profile.gridAlerts) {
        setAnomalies([]);
        return;
      }
      setAnomaliesLoading(true);
      setAnomaliesError('');
      try {
        const data = await anomalyApi.list({ days: 14 });
        if (cancelled) return;
        const rows = Array.isArray(data.flagged)
          ? data.flagged
          : (data.results || []).flatMap((r) => r.flagged || []);
        setAnomalies(rows.slice(0, 20));
      } catch (err) {
        if (!cancelled) setAnomaliesError(err?.message || 'Unable to load anomaly alerts');
      } finally {
        if (!cancelled) setAnomaliesLoading(false);
      }
    }
    loadAnomalies();
    return () => {
      cancelled = true;
    };
  }, [user, profile.gridAlerts]);

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setProfileError('');

    // Module 8.4 — walletAddress is no longer editable here; it is bound via the
    // signed WalletLinkCard flow. Only name + preferences are submitted.
    const errors = {};
    const nameErr = validateName(profile.name);
    if (nameErr) errors.name = nameErr;
    setProfileErrors(errors);
    if (Object.keys(errors).length) return;

    setSavingProfile(true);
    const result = await updateProfile({
      name: profile.name.trim(),
      preferences: {
        emailNotifications: profile.emailNotifications,
        gridAlerts: profile.gridAlerts,
        energyUnit: profile.energyUnit,
      },
    });

    setSavingProfile(false);
    if (result.success) {
      toast.success('Profile saved successfully');
    } else {
      setProfileError(result.message);
      toast.error(result.message);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setPasswordError('');

    const errors = {};
    const currentErr = validatePassword(passwordForm.currentPassword);
    const newErr = validatePasswordStrength(passwordForm.newPassword);
    if (currentErr) errors.currentPassword = currentErr;
    if (newErr) errors.newPassword = newErr;
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }
    setPasswordErrors(errors);
    if (Object.keys(errors).length) return;

    setSavingPassword(true);
    const result = await updatePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });

    setSavingPassword(false);

    if (result.success) {
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password updated. You remain signed in.');
    } else {
      setPasswordError(result.message);
      toast.error(result.message);
    }
  };

  const ErrorBanner = ({ message }) =>
    message ? (
      <div className="flex items-center gap-2 p-3 rounded-lg text-sm mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300">
        <AlertCircle size={16} />
        {message}
      </div>
    ) : null;

  if (!user) return null;

  return (
    <div className="page-section max-w-2xl mx-auto w-full">
      <SectionTitle
        title="Settings"
        subtitle="Manage your profile, security, and grid preferences"
      />

      <section className="content-card">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <div className="p-1.5 bg-emerald-500/10 rounded-lg"><User className="text-emerald-400" size={18} /></div> Profile
        </h3>
        <ErrorBanner message={profileError} />
        <form onSubmit={handleProfileSubmit} className="space-y-5" noValidate>
          <FormField label="Email" id="email" value={user.email} disabled onChange={() => {}} />
          <p className="text-xs text-slate-500 -mt-3">
            {user.isEmailVerified
              ? 'Email verified'
              : 'Email not verified — check your inbox or use the banner to resend'}
          </p>

          <FormField
            label="Display name"
            id="name"
            value={profile.name}
            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
            error={profileErrors.name}
            required
          />

          <button
            type="submit"
            disabled={savingProfile}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-all duration-200 w-full sm:w-auto shadow-lg shadow-emerald-500/15"
          >
            <Save size={18} />
            {savingProfile ? 'Saving...' : 'Save profile'}
          </button>
        </form>
      </section>

      <WalletLinkCard />

      <section className="content-card">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <div className="p-1.5 bg-blue-500/10 rounded-lg"><Bell className="text-blue-400" size={18} /></div> Grid preferences
        </h3>
        <form onSubmit={handleProfileSubmit} className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={profile.emailNotifications}
              onChange={(e) =>
                setProfile((p) => ({ ...p, emailNotifications: e.target.checked }))
              }
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-sm text-slate-300">Email notifications for grid alerts</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={profile.gridAlerts}
              onChange={(e) => setProfile((p) => ({ ...p, gridAlerts: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-sm text-slate-300">Real-time grid anomaly alerts</span>
          </label>

          <div>
            <label htmlFor="energyUnit" className="block text-sm font-medium text-slate-300 mb-1">
              Energy display unit
            </label>
            <select
              id="energyUnit"
              value={profile.energyUnit}
              onChange={(e) => setProfile((p) => ({ ...p, energyUnit: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-600 bg-slate-900 text-white rounded-md text-sm focus:ring-emerald-500 focus:border-emerald-500"
            >
              <option value="kWh">kWh</option>
              <option value="MWh">MWh</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={savingProfile}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-all duration-200 w-full sm:w-auto shadow-lg shadow-emerald-500/15"
          >
            <Save size={18} />
            {savingProfile ? 'Saving...' : 'Save preferences'}
          </button>
        </form>
      </section>

      {profile.gridAlerts && (
        <section className="content-card">
          <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
            <div className="p-1.5 bg-rose-500/10 rounded-lg"><Activity className="text-rose-400" size={18} /></div>
            Grid anomaly alerts
          </h3>

          {anomaliesLoading && (
            <p className="text-sm text-slate-400">Scanning your meters for anomalies…</p>
          )}
          {anomaliesError && (
            <div className="flex items-center gap-2 text-sm text-rose-300">
              <AlertCircle size={16} /> {anomaliesError}
            </div>
          )}
          {!anomaliesLoading && !anomaliesError && anomalies.length === 0 && (
            <p className="text-sm text-slate-400">
              No anomalies detected in the last 14 days. Your meters look healthy.
            </p>
          )}
          {anomalies.length > 0 && (
            <ul className="space-y-2">
              {anomalies.map((a, i) => {
                const score = typeof a.anomaly_score === 'number' ? Math.round(a.anomaly_score * 100) : null;
                const codes = Array.isArray(a.reason_codes) ? a.reason_codes : [];
                return (
                  <li
                    key={i}
                    className="flex items-start justify-between gap-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-white capitalize">
                        {codes[0]?.replace(/_/g, ' ') || 'meter anomaly'}
                      </p>
                      <p className="text-xs text-slate-400">
                        {a.timestamp ? new Date(a.timestamp).toLocaleString() : ''}
                      </p>
                    </div>
                    {score !== null && (
                      <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-300">
                        {score}%
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="content-card">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <div className="p-1.5 bg-amber-500/10 rounded-lg"><Lock className="text-amber-400" size={18} /></div> Security
        </h3>
        <ErrorBanner message={passwordError} />
        <form onSubmit={handlePasswordSubmit} className="space-y-5" noValidate>
          <FormField
            label="Current password"
            id="currentPassword"
            type="password"
            value={passwordForm.currentPassword}
            onChange={(e) =>
              setPasswordForm((p) => ({ ...p, currentPassword: e.target.value }))
            }
            error={passwordErrors.currentPassword}
            required
            autoComplete="current-password"
            maxLength={128}
          />

          <FormField
            label="New password"
            id="newPassword"
            type="password"
            value={passwordForm.newPassword}
            onChange={(e) => setPasswordForm((p) => ({ ...p, newPassword: e.target.value }))}
            error={passwordErrors.newPassword}
            required
            autoComplete="new-password"
            hint="Min 8 characters, uppercase letter and number"
            maxLength={128}
          />

          <FormField
            label="Confirm new password"
            id="confirmPassword"
            type="password"
            value={passwordForm.confirmPassword}
            onChange={(e) =>
              setPasswordForm((p) => ({ ...p, confirmPassword: e.target.value }))
            }
            error={passwordErrors.confirmPassword}
            required
            autoComplete="new-password"
            maxLength={128}
          />

          <button
            type="submit"
            disabled={savingPassword}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-slate-700/70 hover:bg-slate-600/70 disabled:opacity-50 text-white font-medium rounded-xl transition-colors w-full sm:w-auto border border-slate-600/30"
          >
            <Lock size={18} />
            {savingPassword ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </section>

      <section className="content-card">
        <p className="text-sm text-slate-500 mb-4">Signed in as <span className="text-slate-300">{user.email}</span></p>
        <button
          onClick={logout}
          className="text-sm text-rose-400 hover:text-rose-300 font-medium"
        >
          Sign out of all devices
        </button>
      </section>
    </div>
  );
};

export default Settings;
