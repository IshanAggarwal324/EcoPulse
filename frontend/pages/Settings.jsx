import React, { useState, useEffect } from 'react';
import { User, Lock, Bell, Save, CheckCircle, AlertCircle } from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import FormField from '../components/ui/FormField';
import { useAuth } from '../context/AuthContext';
import {
  validateName,
  validateWalletAddress,
  validatePassword,
  validatePasswordStrength,
} from '../utils/validation';

const Settings = () => {
  const { user, updateProfile, updatePassword, logout } = useAuth();

  const [profile, setProfile] = useState({
    name: '',
    walletAddress: '',
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
  const [profileMessage, setProfileMessage] = useState({ type: '', text: '' });
  const [passwordMessage, setPasswordMessage] = useState({ type: '', text: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setProfile({
        name: user.name || '',
        walletAddress: user.walletAddress || '',
        emailNotifications: user.preferences?.emailNotifications ?? true,
        gridAlerts: user.preferences?.gridAlerts ?? true,
        energyUnit: user.preferences?.energyUnit || 'kWh',
      });
    }
  }, [user]);

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setProfileMessage({ type: '', text: '' });

    const errors = {};
    const nameErr = validateName(profile.name);
    const walletErr = validateWalletAddress(profile.walletAddress);
    if (nameErr) errors.name = nameErr;
    if (walletErr) errors.walletAddress = walletErr;
    setProfileErrors(errors);
    if (Object.keys(errors).length) return;

    setSavingProfile(true);
    const result = await updateProfile({
      name: profile.name.trim(),
      walletAddress: profile.walletAddress.trim() || null,
      preferences: {
        emailNotifications: profile.emailNotifications,
        gridAlerts: profile.gridAlerts,
        energyUnit: profile.energyUnit,
      },
    });

    setSavingProfile(false);
    setProfileMessage({
      type: result.success ? 'success' : 'error',
      text: result.success ? 'Profile saved successfully' : result.message,
    });
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setPasswordMessage({ type: '', text: '' });

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
      setPasswordMessage({ type: 'success', text: 'Password updated. You remain signed in.' });
    } else {
      setPasswordMessage({ type: 'error', text: result.message });
    }
  };

  const StatusBanner = ({ message }) => {
    if (!message.text) return null;
    const isSuccess = message.type === 'success';
    return (
      <div
        className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-4 ${
          isSuccess
            ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
            : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
        }`}
      >
        {isSuccess ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
        {message.text}
      </div>
    );
  };

  if (!user) return null;

  return (
    <div className="space-y-8 pb-8 max-w-2xl">
      <SectionTitle
        title="Settings"
        subtitle="Manage your profile, security, and grid preferences"
      />

      {/* Profile */}
      <section className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <User className="text-emerald-400" size={20} /> Profile
        </h3>
        <StatusBanner message={profileMessage} />
        <form onSubmit={handleProfileSubmit} className="space-y-5" noValidate>
          <FormField label="Email" id="email" value={user.email} disabled onChange={() => {}} />
          <p className="text-xs text-slate-500 -mt-3">Email cannot be changed</p>

          <FormField
            label="Display name"
            id="name"
            value={profile.name}
            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
            error={profileErrors.name}
            required
          />

          <FormField
            label="Wallet address"
            id="walletAddress"
            value={profile.walletAddress}
            onChange={(e) => setProfile((p) => ({ ...p, walletAddress: e.target.value }))}
            error={profileErrors.walletAddress}
            placeholder="0x..."
            hint="Used for carbon credit balance on the dashboard"
          />

          <button
            type="submit"
            disabled={savingProfile}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
          >
            <Save size={18} />
            {savingProfile ? 'Saving...' : 'Save profile'}
          </button>
        </form>
      </section>

      {/* Preferences */}
      <section className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <Bell className="text-blue-400" size={20} /> Grid preferences
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
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
          >
            <Save size={18} />
            {savingProfile ? 'Saving...' : 'Save preferences'}
          </button>
        </form>
      </section>

      {/* Password */}
      <section className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-6 shadow-xl">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
          <Lock className="text-amber-400" size={20} /> Security
        </h3>
        <StatusBanner message={passwordMessage} />
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
          />

          <button
            type="submit"
            disabled={savingPassword}
            className="flex items-center gap-2 px-5 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
          >
            <Lock size={18} />
            {savingPassword ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </section>

      <section className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-6">
        <p className="text-sm text-slate-400 mb-4">Signed in as {user.email}</p>
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
