import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchAllListings,
  listEnergy,
  purchaseEnergy,
  cancelListing,
  approveTokensIfNeeded,
  mintDevTokens,
  subscribeEnergyTradingEvents,
} from '../utils/blockchain';
import { tradesApi, analyticsApi } from '../utils/api';
import SectionTitle from '../components/ui/SectionTitle';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';

const EVENT_LABELS = {
  listed: 'Listed',
  purchased: 'Purchased',
  cancelled: 'Cancelled',
};

const formatAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const Trading = () => {
  const [listings, setListings] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');

  const {
    account,
    connect,
    connecting,
    isCorrectNetwork,
    refreshBalance,
    ensureNetwork,
  } = useWallet();
  const toast = useToast();

  const loadListings = useCallback(async () => {
    const activeListings = await fetchAllListings();
    setListings(activeListings);
  }, []);

  const loadHistory = useCallback(async (wallet, syncFirst = false) => {
    setHistoryLoading(true);
    try {
      const params = { limit: 25 };
      if (wallet) params.wallet = wallet;

      const response = syncFirst
        ? await tradesApi.syncHistory(params)
        : await tradesApi.getHistory(params);

      setHistory(response.data?.trades || []);
    } catch (err) {
      if (!syncFirst) {
        try {
          const fallback = await tradesApi.getHistory({ limit: 25, ...(wallet ? { wallet } : {}) });
          setHistory(fallback.data?.trades || []);
        } catch {
          toast.error(err.message || 'Failed to load transaction history');
        }
      } else {
        toast.error(err.message || 'Failed to sync transaction history');
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadListings();
    loadHistory(account, Boolean(account));
  }, [account, loadListings, loadHistory]);

  useEffect(() => {
    const unsubscribe = subscribeEnergyTradingEvents({
      onListed: () => {
        loadListings();
        toast.info('New energy listing detected on-chain');
      },
      onPurchased: () => {
        loadListings();
        if (account) loadHistory(account, true);
        refreshBalance();
        toast.info('Purchase detected on-chain');
      },
      onCancelled: () => {
        loadListings();
        toast.info('Listing cancellation detected on-chain');
      },
    });

    return unsubscribe;
  }, [account, loadListings, loadHistory, refreshBalance, toast]);

  const requireWallet = async () => {
    if (account) return true;
    toast.info('Connect your wallet to continue');
    try {
      await connect();
      return true;
    } catch (err) {
      toast.error(err.message || 'Wallet connection required');
      return false;
    }
  };

  const requireCorrectNetwork = async () => {
    if (isCorrectNetwork) return true;
    toast.info('Switch to the expected network in MetaMask');
    try {
      await ensureNetwork();
      return true;
    } catch (err) {
      toast.error(err.message || 'Please switch to the correct network');
      return false;
    }
  };

  const afterChainTx = async (receipt) => {
    await loadListings();
    await refreshBalance();
    try {
      await analyticsApi.syncBlockchain();
    } catch {
      // Backend sync is best-effort
    }
    if (account) await loadHistory(account, true);
    if (receipt?.hash) {
      toast.info(`Tx: ${receipt.hash.slice(0, 10)}...`);
    }
  };

  const handleListEnergy = async (e) => {
    e.preventDefault();
    if (!(await requireWallet()) || !(await requireCorrectNetwork())) return;
    if (!amount || !price) return;

    setLoading(true);
    toast.info('Confirm transaction in MetaMask...');

    try {
      const receipt = await listEnergy(amount, price);
      toast.success('Energy listed successfully!');
      setAmount('');
      setPrice('');
      await afterChainTx(receipt);
    } catch (err) {
      toast.error(err.message || 'Transaction failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePurchase = async (id, priceStr) => {
    if (!(await requireWallet()) || !(await requireCorrectNetwork())) return;

    setLoading(true);
    try {
      const approvalReceipt = await approveTokensIfNeeded(priceStr);

      if (approvalReceipt) {
        toast.info('Step 1/2: Approval confirmed. Confirm purchase in MetaMask...');
      } else {
        toast.info('Allowance sufficient. Confirm purchase in MetaMask...');
      }

      const receipt = await purchaseEnergy(id);
      toast.success('Energy purchased successfully!');
      await afterChainTx(receipt);
    } catch (err) {
      toast.error(err.message || 'Purchase failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (id) => {
    if (!(await requireWallet()) || !(await requireCorrectNetwork())) return;

    setLoading(true);
    try {
      toast.info('Confirm cancellation in MetaMask...');
      const receipt = await cancelListing(id);
      toast.success('Listing cancelled');
      await afterChainTx(receipt);
    } catch (err) {
      toast.error(err.message || 'Cancellation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      <SectionTitle
        title="Peer-to-Peer Energy Trading"
        subtitle="List and purchase energy using carbon credits on-chain"
      />

      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-slate-800/80 border border-slate-700/50 rounded-xl">
          <p className="text-slate-300 text-sm">
            Connect MetaMask to list, buy, or cancel energy on-chain.
          </p>
          <button
            type="button"
            onClick={() => connect().catch(() => {})}
            disabled={connecting}
            className="touch-target shrink-0 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        </div>
      )}

      {account && !isCorrectNetwork && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <p className="text-amber-200 text-sm">
            Your wallet is on the wrong network. Switch before trading.
          </p>
          <button
            type="button"
            onClick={() => ensureNetwork().catch((e) => toast.error(e.message))}
            className="touch-target shrink-0 bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30 font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-1 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl h-fit">
          <h3 className="text-xl font-bold text-white mb-4">List Energy for Sale</h3>
          <form onSubmit={handleListEnergy} className="space-y-4">
            <div>
              <label className="block text-slate-400 text-sm mb-1">Energy Amount (Units)</label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500"
                placeholder="e.g. 100"
                required
              />
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Price (in CC)</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500"
                placeholder="e.g. 10"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading || !account || !isCorrectNetwork}
              className="touch-target w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
            >
              {loading ? 'Processing...' : 'Create Listing'}
            </button>
          </form>

          <div className="mt-8 pt-4 border-t border-slate-700/50">
            <p className="text-xs text-slate-500 mb-2">Dev Tools (Hardhat Local Only)</p>
            <button
              type="button"
              onClick={() =>
                mintDevTokens(100)
                  .then(() => {
                    toast.success('Minted 100 CC!');
                    refreshBalance();
                  })
                  .catch((e) => toast.error(e.message))
              }
              disabled={!account || !isCorrectNetwork}
              className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-300 text-sm py-2 rounded-lg"
            >
              Mint 100 CC to Self
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl min-w-0">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
            <h3 className="text-lg sm:text-xl font-bold text-white">Active Market Listings</h3>
            <button
              type="button"
              onClick={() => { loadListings(); toast.info('Listings refreshed'); }}
              className="touch-target text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2"
            >
              Refresh
            </button>
          </div>

          {listings.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-slate-700 rounded-xl">
              <p className="text-slate-400">No active energy listings found.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {listings.map((listing) => (
                <div
                  key={listing.id}
                  className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded-md">ID: {listing.id}</span>
                      <span className="text-sm text-slate-400 font-mono">Seller: {formatAddress(listing.seller)}</span>
                    </div>
                    <p className="text-white font-medium text-lg">{listing.energyAmount} Energy Units</p>
                  </div>
                  <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
                    <div className="text-right">
                      <p className="text-xs text-slate-500 uppercase tracking-wider">Price</p>
                      <p className="text-emerald-400 font-bold">{listing.price} CC</p>
                    </div>
                    {account && account.toLowerCase() === listing.seller.toLowerCase() ? (
                      <button
                        type="button"
                        onClick={() => handleCancel(listing.id)}
                        disabled={loading || !isCorrectNetwork}
                        className="touch-target bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white px-4 py-3 rounded-lg font-medium transition-colors w-full sm:w-auto"
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handlePurchase(listing.id, listing.price)}
                        disabled={loading || !isCorrectNetwork}
                        className="touch-target bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white px-4 py-3 rounded-lg font-medium transition-colors w-full sm:w-auto"
                      >
                        Buy Energy
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
          <div>
            <h3 className="text-lg sm:text-xl font-bold text-white">Transaction History</h3>
            <p className="text-sm text-slate-400 mt-1">
              {account ? 'Your on-chain trades indexed by the backend' : 'All indexed marketplace transactions'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadHistory(account, true)}
            disabled={historyLoading}
            className="touch-target text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2 disabled:opacity-50"
          >
            {historyLoading ? 'Syncing...' : 'Sync from chain'}
          </button>
        </div>

        {historyLoading && history.length === 0 ? (
          <p className="text-slate-400 text-center py-8">Loading transaction history...</p>
        ) : history.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-slate-700 rounded-xl">
            <p className="text-slate-400">No transactions indexed yet. Run a trade or sync from chain.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[640px]">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="py-3 pr-4 font-medium">Type</th>
                  <th className="py-3 pr-4 font-medium">Listing</th>
                  <th className="py-3 pr-4 font-medium">Energy</th>
                  <th className="py-3 pr-4 font-medium">Price (CC)</th>
                  <th className="py-3 pr-4 font-medium">Parties</th>
                  <th className="py-3 pr-4 font-medium">Block</th>
                  <th className="py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((trade) => (
                  <tr key={`${trade.txHash}-${trade.logIndex}`} className="border-b border-slate-700/50 text-slate-200">
                    <td className="py-3 pr-4">
                      <span className={`text-xs px-2 py-1 rounded-md ${
                        trade.eventType === 'purchased'
                          ? 'bg-blue-500/10 text-blue-300'
                          : trade.eventType === 'cancelled'
                            ? 'bg-amber-500/10 text-amber-300'
                            : 'bg-emerald-500/10 text-emerald-300'
                      }`}
                      >
                        {EVENT_LABELS[trade.eventType] || trade.eventType}
                      </span>
                    </td>
                    <td className="py-3 pr-4">#{trade.listingId}</td>
                    <td className="py-3 pr-4">{trade.energyAmount || '—'}</td>
                    <td className="py-3 pr-4">{trade.price !== '0' ? trade.price : '—'}</td>
                    <td className="py-3 pr-4 font-mono text-xs">
                      <div>S: {formatAddress(trade.seller)}</div>
                      {trade.buyer && <div>B: {formatAddress(trade.buyer)}</div>}
                    </td>
                    <td className="py-3 pr-4">{trade.blockNumber ?? '—'}</td>
                    <td className="py-3 text-slate-400">{formatDate(trade.blockTimestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default Trading;
