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
    <div className="glass-card rounded-2xl p-5 sm:p-6 card-hover-glow glow-emerald flex flex-col justify-center h-full">
      <h3 className="text-lg sm:text-xl font-bold text-white mb-4">Network Status</h3>

      {!account ? (
        <p className="text-slate-500 text-sm">Connect wallet to view network details.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-slate-500 text-sm">Chain ID</p>
            <p className="text-white text-sm font-medium font-mono">{chainId ?? 'Loading...'}</p>
          </div>
          <div className="flex justify-between items-center">
            <p className="text-slate-500 text-sm">Latest Block</p>
            <p className="text-white text-sm font-medium font-mono">{blockNumber || 'Loading...'}</p>
          </div>

          {isCorrectNetwork ? (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {String(expectedChainId) === '31337' ? 'Hardhat Local Node' : 'Correct Network'}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                Wrong Network (expected {expectedChainId})
              </div>
              <button
                type="button"
                onClick={() => ensureNetwork().catch(console.error)}
                className="touch-target w-full text-sm bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 font-medium px-3 py-2 rounded-xl transition-colors"
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
