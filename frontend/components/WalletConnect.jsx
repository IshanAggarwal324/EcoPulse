import React, { memo } from 'react';
import { useWalletState, useWalletActions } from '../context/WalletContext';

const WalletConnect = memo(function WalletConnect() {
  const {
    account,
    balance,
    connecting,
    reconnecting,
    error,
    isCorrectNetwork,
    expectedChainId,
    hadPreviousSession,
  } = useWalletState();

  const {
    connect,
    reconnect,
    disconnect,
    ensureNetwork,
  } = useWalletActions();

  const handleConnect = async () => {
    try {
      if (hadPreviousSession) {
        await reconnect();
      } else {
        await connect();
      }
    } catch {
    }
  };

  const handleSwitchNetwork = async () => {
    try {
      await ensureNetwork();
    } catch (err) {
      console.error('Network switch failed:', err);
    }
  };

  const connectLabel = reconnecting
    ? 'Reconnecting...'
    : connecting
      ? 'Connecting...'
      : hadPreviousSession
        ? 'Reconnect MetaMask'
        : 'Connect MetaMask';

  return (
    <div className="glass-card rounded-2xl p-5 sm:p-6 card-hover-glow glow-emerald flex flex-col justify-center min-h-[140px]">
      <h3 className="text-lg sm:text-xl font-bold text-white mb-4">Wallet Connection</h3>

      {reconnecting && (
        <p className="text-slate-400 text-sm mb-3">Restoring wallet session...</p>
      )}

      {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}

      {!account ? (
        <div className="space-y-2">
          <p className="text-slate-500 text-xs">
            Wallet address is stored in this browser tab only and expires after 4 hours.
            Avoid connecting on shared or public computers.
          </p>
          {hadPreviousSession && !reconnecting && (
            <p className="text-slate-500 text-xs">
              Previous session detected. Reconnect to continue trading.
            </p>
          )}
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting}
            className="touch-target w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white font-semibold px-4 py-3 rounded-xl transition-all duration-200 disabled:opacity-50 shadow-lg shadow-emerald-500/15"
          >
            {connectLabel}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-slate-500 text-xs">
            Session active in this tab. Disconnect when finished, especially on shared devices.
          </p>
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Address:</strong>{' '}
            {account.slice(0, 6)}...{account.slice(-4)}
          </p>
          <p className="text-slate-300 text-sm">
            <strong className="text-white">CC Balance:</strong>{' '}
            <span className="text-emerald-400 font-bold">{balance} CC</span>
          </p>

          {!isCorrectNetwork && (
            <div className="space-y-2">
              <p className="text-amber-400 text-xs">
                Wrong network. Expected chain ID {expectedChainId}.
              </p>
              <button
                type="button"
                onClick={handleSwitchNetwork}
                className="touch-target w-full bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 font-medium px-4 py-2 rounded-xl transition-colors text-sm"
              >
                Switch Network
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={disconnect}
            className="touch-target w-full bg-rose-500/10 text-rose-400 border border-rose-500/25 hover:bg-rose-500/20 font-medium px-4 py-2.5 rounded-xl transition-colors"
          >
            Disconnect Wallet
          </button>
        </div>
      )}
    </div>
  );
});

export default WalletConnect;
