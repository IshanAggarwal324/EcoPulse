import React, { useState, useEffect } from 'react';
import { getNetwork, getProvider } from '../utils/blockchain';

const BlockchainStatus = ({ account }) => {
  const [networkId, setNetworkId] = useState(null);
  const [blockNumber, setBlockNumber] = useState(null);

  useEffect(() => {
    const fetchNetworkInfo = async () => {
      try {
        const network = await getNetwork();
        if (network) {
          setNetworkId(network.chainId.toString());
        }
        const provider = getProvider();
        if (provider) {
          const block = await provider.getBlockNumber();
          setBlockNumber(block.toString());
        }
      } catch (err) {
        console.warn("Network info fetch failed (likely RPC rate limit):", err.message);
      }
    };

    if (account) {
      fetchNetworkInfo();
      const interval = setInterval(fetchNetworkInfo, 5000);
      return () => clearInterval(interval);
    } else {
        setNetworkId(null);
        setBlockNumber(null);
    }
  }, [account]);

  return (
    <div className="p-4 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-xl flex flex-col justify-center h-full">
      <h3 className="text-xl font-bold text-white mb-4">Network Status</h3>
      
      {!account ? (
        <p className="text-slate-400 text-sm">Please connect wallet to view network details.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Chain ID:</strong> {networkId || 'Loading...'}
          </p>
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Latest Block:</strong> {blockNumber || 'Loading...'}
          </p>
          {networkId === "31337" && (
            <div className="mt-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Hardhat Local Node
            </div>
          )}
          {networkId && networkId !== "31337" && (
            <div className="mt-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              Not Localhost (Caution)
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BlockchainStatus;
