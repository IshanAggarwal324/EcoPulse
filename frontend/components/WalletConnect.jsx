import React, { useState } from 'react';

const WalletConnect = () => {
  const [account, setAccount] = useState(null);

  const connectWallet = async () => {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setAccount(accounts[0]);
      } catch (error) {
        console.error("User denied account access or error occurred:", error);
      }
    } else {
      alert("Please install MetaMask!");
    }
  };

  return (
    <div className="wallet-connect p-4 border rounded shadow-sm bg-white dark:bg-gray-800">
      <h3 className="text-lg font-bold mb-2">MetaMask Integration</h3>
      {account ? (
        <p className="text-green-600">Connected: {account.slice(0, 6)}...{account.slice(-4)}</p>
      ) : (
        <button 
          onClick={connectWallet}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
        >
          Connect Wallet
        </button>
      )}
    </div>
  );
};

export default WalletConnect;
