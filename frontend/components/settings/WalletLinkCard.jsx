import React, { useState } from 'react';
import { Wallet, Link2, Unlink, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useWallet } from '../../context/WalletContext';
import { useToast } from '../../context/ToastContext';
import { walletApi } from '../../utils/api';
import { signWalletLink } from '../../utils/walletLink';
import { validateWalletAddress } from '../../utils/validation';

const sameWallet = (a, b) => {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
};

const shortAddr = (addr) =>
  addr ? `${String(addr).slice(0, 6)}…${String(addr).slice(-4)}` : '';

/**
 * Module 8.4 — "Sign to link" wallet binding.
 *
 * Replaces the legacy free-text wallet field. A wallet may only be bound to the
 * account by signing an EIP-712 challenge issued by the server. Unlinking
 * requires the user's current password (re-auth) so a stolen session token can't
 * drop and relink a victim's wallet.
 */
const WalletLinkCard = () => {
  const { user, refreshUser } = useAuth();
  const { account, connect, connecting: walletConnecting } = useWallet();
  const toast = useToast();

  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [showUnlink, setShowUnlink] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');

  const linkedWallet = user?.walletAddress || null;
  const isVerified = Boolean(linkedWallet && user?.walletLinkedAt);
  // Connected wallet differs from (or isn't yet) the linked wallet.
  const needsLink = account && !sameWallet(account, linkedWallet);

  const handleLink = async () => {
    setError('');
    if (!account) {
      setError('Connect your wallet first.');
      return;
    }
    if (validateWalletAddress(account)) {
      setError('The connected account is not a valid wallet address.');
      return;
    }

    setLinking(true);
    try {
      const challenge = await walletApi.getChallenge(account);
      const typedData = challenge?.data?.typedData;
      if (!typedData) {
        throw new Error('Server did not return a valid challenge.');
      }
      const { signature, signer } = await signWalletLink(typedData);
      if (!sameWallet(signer, account)) {
        throw new Error('Signed wallet does not match the connected account.');
      }
      await walletApi.link({ wallet: account, signature });
      await refreshUser();
      toast.success('Wallet linked successfully.');
    } catch (err) {
      const msg = err?.message || 'Failed to link wallet.';
      setError(msg);
      toast.error(msg);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async (e) => {
    e.preventDefault();
    setError('');
    if (!currentPassword) {
      setError('Enter your current password to unlink.');
      return;
    }
    setUnlinking(true);
    try {
      await walletApi.unlink({ currentPassword });
      await refreshUser();
      setShowUnlink(false);
      setCurrentPassword('');
      toast.success('Wallet unlinked.');
    } catch (err) {
      const msg = err?.message || 'Failed to unlink wallet.';
      setError(msg);
      toast.error(msg);
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <div className="content-card">
      <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-2">
        <div className="p-1.5 bg-violet-500/10 rounded-lg">
          <Wallet className="text-violet-400" size={18} />
        </div>{' '}
        Wallet linking
      </h3>
      <p className="text-xs text-slate-500 mb-5">
        Your wallet backs carbon credits, settlements and trades. Link it with a
        cryptographic signature — never by pasting an address.
      </p>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg text-sm mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* Current state */}
      <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 px-4 py-3 mb-4">
        {linkedWallet ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-white font-mono break-all">{linkedWallet}</p>
              <p className="text-xs mt-0.5 flex items-center gap-1">
                {isVerified ? (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <ShieldCheck size={12} /> Verified
                    {user?.walletLinkedAt
                      ? ` · ${new Date(user.walletLinkedAt).toLocaleDateString()}`
                      : ''}
                  </span>
                ) : (
                  <span className="text-amber-400 flex items-center gap-1">
                    <AlertCircle size={12} /> Manually entered — sign to verify
                  </span>
                )}
              </p>
            </div>
            {!showUnlink && (
              <button
                type="button"
                onClick={() => setShowUnlink(true)}
                className="shrink-0 text-xs text-rose-400 hover:text-rose-300 font-medium"
              >
                Unlink
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-400">No wallet linked yet.</p>
        )}
      </div>

      {/* Unlink (password re-auth) */}
      {showUnlink && (
        <form onSubmit={handleUnlink} className="space-y-3 mb-4">
          <p className="text-xs text-slate-400">
            Enter your current password to confirm unlinking. This is required so
            a compromised session can't change your wallet.
          </p>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
            maxLength={128}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-900 text-white rounded-md text-sm focus:ring-rose-500 focus:border-rose-500"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={unlinking}
              className="touch-target flex items-center gap-2 px-4 py-2 bg-rose-600/80 hover:bg-rose-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {unlinking ? <Loader2 size={16} className="animate-spin" /> : <Unlink size={16} />}
              Confirm unlink
            </button>
            <button
              type="button"
              onClick={() => {
                setShowUnlink(false);
                setCurrentPassword('');
                setError('');
              }}
              className="touch-target px-4 py-2 text-slate-300 hover:text-white text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Link / connect actions */}
      {!showUnlink && (
        <div className="flex flex-col sm:flex-row gap-2">
          {needsLink ? (
            <button
              type="button"
              onClick={handleLink}
              disabled={linking}
              className="touch-target flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-r from-violet-500 to-violet-600 hover:from-violet-400 hover:to-violet-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-violet-500/15"
            >
              {linking ? <Loader2 size={18} className="animate-spin" /> : <Link2 size={18} />}
              {linking ? 'Sign in your wallet…' : `Sign to link ${shortAddr(account)}`}
            </button>
          ) : !linkedWallet ? (
            <button
              type="button"
              onClick={connect}
              disabled={walletConnecting}
              className="touch-target flex items-center justify-center gap-2 px-5 py-3 bg-slate-700/70 hover:bg-slate-600/70 disabled:opacity-50 text-white font-medium rounded-xl transition-colors border border-slate-600/30"
            >
              <Wallet size={18} />
              {walletConnecting ? 'Connecting…' : 'Connect wallet to link'}
            </button>
          ) : (
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <ShieldCheck size={14} className="text-emerald-400" />
              Connected wallet matches your linked wallet.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default WalletLinkCard;
