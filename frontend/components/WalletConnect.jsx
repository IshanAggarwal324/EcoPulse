import React, { useState, useEffect } from 'react';
import { getProvider, getCarbonCreditBalance } from '../utils/blockchain';

const WalletConnect = ({ onConnect, onDisconnect, account }) => {
  const [balance, setBalance] = useState("0");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const connectWallet = async () => {
    setLoading(true);
    setError("");
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("MetaMask is not installed. Please install it to use this app.");
      }
      
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts.length > 0) {
        onConnect(accounts[0]);
      }
    } catch (err) {
      setError(err.message || "Failed to connect wallet.");
    } finally {
      setLoading(false);
    }
  };

  const disconnectWallet = () => {
    onDisconnect();
    setBalance("0");
  };

  useEffect(() => {
    const fetchBalance = async () => {
      if (account) {
        const bal = await getCarbonCreditBalance(account);
        setBalance(bal);
      }
    };
    fetchBalance();
  }, [account]);

  return (
    <div className="p-4 sm:p-6 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-xl flex flex-col justify-center min-h-[140px]">
      <h3 className="text-lg sm:text-xl font-bold text-white mb-4">Wallet Connection</h3>
      
      {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
      
      {!account ? (
        <button 
          onClick={connectWallet} 
          disabled={loading}
          className="touch-target w-full bg-emerald-500 hover:bg-emerald-600 text-white font-medium px-4 py-3 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? "Connecting..." : "Connect MetaMask"}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Address:</strong> {account.slice(0, 6)}...{account.slice(-4)}
          </p>
          <p className="text-slate-300 text-sm">
            <strong className="text-white">CC Balance:</strong> <span className="text-emerald-400 font-bold">{balance} CC</span>
          </p>
          <button 
            onClick={disconnectWallet}
            className="touch-target w-full bg-rose-500/20 text-rose-400 border border-rose-500/50 hover:bg-rose-500/30 font-medium px-4 py-3 rounded-lg transition-colors"
          >
            Disconnect Wallet
          </button>
        </div>
      )}
    </div>
  );
};

export default WalletConnect;
