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
    <div className="p-4 border rounded shadow-md bg-white">
      <h2 className="text-xl font-bold mb-4">Wallet Configuration</h2>
      
      {error && <p className="text-red-500 mb-2">{error}</p>}
      
      {!account ? (
        <button 
          onClick={connectWallet} 
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Connecting..." : "Connect MetaMask"}
        </button>
      ) : (
        <div className="space-y-2">
          <p><strong>Address:</strong> {account.slice(0, 6)}...{account.slice(-4)}</p>
          <p><strong>CC Balance:</strong> {balance} CC</p>
          <button 
            onClick={disconnectWallet}
            className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 mt-2"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
};

export default WalletConnect;
