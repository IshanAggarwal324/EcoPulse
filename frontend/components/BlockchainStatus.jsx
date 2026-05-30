import React, { memo, useState, useEffect } from 'react';
import { getProvider } from '../utils/blockchain';
import { useWalletState, useWalletActions } from '../context/WalletContext';

const BlockchainStatus = memo(function BlockchainStatus() {
  const { account, chainId, isCorrectNetwork, expectedChainId } = useWalletState();
  const { ensureNetwork } = useWalletActions();
  const [blockNumber, setBlockNumber] = useState(null);

  useEffect(() => {
    const fetchBlock = async () => {
      try {
        const provider = getProvider();
        if (provider) {
          const block = await provider.getBlockNumber();
          setBlockNumber(block.toString());
        }
      } catch (err) {
        console.warn('Block fetch failed:', err.message);
      }
    };

    if (account) {
      fetchBlock();
      const interval = setInterval(fetchBlock, 5000);
      return () => clearInterval(interval);
    }

    setBlockNumber(null);
    return undefined;
  }, [account, chainId]);

  return (
    <div className="p-4 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-xl flex flex-col justify-center h-full">
      <h3 className="text-xl font-bold text-white mb-4">Network Status</h3>

      {!account ? (
        <p className="text-slate-400 text-sm">Please connect wallet to view network details.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Chain ID:</strong>{' '}
            {chainId ?? 'Loading...'}
          </p>
          <p className="text-slate-300 text-sm">
            <strong className="text-white">Latest Block:</strong>{' '}
            {blockNumber || 'Loading...'}
          </p>

          {isCorrectNetwork ? (
            <div className="mt-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {String(expectedChainId) === '31337' ? 'Hardhat Local Node' : 'Correct Network'}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                Wrong Network (expected {expectedChainId})
              </div>
              <button
                type="button"
                onClick={() => ensureNetwork().catch(console.error)}
                className="touch-target w-full text-sm bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30 font-medium px-3 py-2 rounded-lg transition-colors"
              >
                Switch to Expected Network
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default BlockchainStatus;
