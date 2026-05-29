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
import { marketplaceApi, tradesApi, analyticsApi } from '../utils/api';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import MarketplaceOrderCard from '../components/ui/MarketplaceOrderCard';
import EmptyState from '../components/ui/EmptyState';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import { Loader2, Store, ListOrdered, Zap } from 'lucide-react';

const EVENT_LABELS = {
  listed: 'Listed',
  purchased: 'Purchased',
  cancelled: 'Cancelled',
};

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'energy_desc', label: 'Energy: high to low' },
  { value: 'unit_price_asc', label: 'Unit price: low to high' },
];

const formatAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const Trading = () => {
  const [orders, setOrders] = useState([]);
  const [orderSummary, setOrderSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [listingsLoading, setListingsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('market');
  const [sort, setSort] = useState('newest');

  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');

  const {
    account,
    connect,
    reconnect,
    connecting,
    hadPreviousSession,
    isCorrectNetwork,
    refreshBalance,
    ensureNetwork,
  } = useWallet();
  const toast = useToast();

  const loadOrders = useCallback(async () => {
    setListingsLoading(true);
    try {
      const params = { sort, limit: 100 };
      if (view === 'mine' && account) {
        params.seller = account;
      }

      const response = await marketplaceApi.getOrders(params);
      setOrders(response.data?.orders || []);
      setOrderSummary(response.data?.summary || null);
    } catch {
      const fallback = await fetchAllListings();
      let mapped = fallback.map((listing) => {
        const energyAmount = Number(listing.energyAmount) || 0;
        const priceNum = Number(listing.price) || 0;
        return {
          listingId: listing.id,
          seller: listing.seller,
          energyAmount,
          price: priceNum,
          unitPrice: energyAmount > 0 ? priceNum / energyAmount : 0,
          status: 'active',
          createdAt: listing.createdAt
            ? new Date(listing.createdAt * 1000).toISOString()
            : null,
        };
      });

      if (view === 'mine' && account) {
        mapped = mapped.filter(
          (o) => o.seller.toLowerCase() === account.toLowerCase()
        );
      }

      setOrders(mapped);
      setOrderSummary({
        totalActive: mapped.length,
        totalEnergy: mapped.reduce((s, o) => s + o.energyAmount, 0),
        totalVolumeCc: mapped.reduce((s, o) => s + o.price, 0),
        avgUnitPrice:
          mapped.length > 0
            ? mapped.reduce((s, o) => s + o.unitPrice, 0) / mapped.length
            : 0,
      });
    } finally {
      setListingsLoading(false);
    }
  }, [account, sort, view]);

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
          const fallback = await tradesApi.getHistory({
            limit: 25,
            ...(wallet ? { wallet } : {}),
          });
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
    loadOrders();
    loadHistory(account, Boolean(account));
  }, [account, loadOrders, loadHistory]);

  useEffect(() => {
    const unsubscribe = subscribeEnergyTradingEvents({
      onListed: () => {
        loadOrders();
        toast.info('New marketplace order listed');
      },
      onPurchased: () => {
        loadOrders();
        if (account) loadHistory(account, true);
        refreshBalance();
        toast.info('Order filled on-chain');
      },
      onCancelled: () => {
        loadOrders();
        toast.info('Order cancelled');
      },
    });

    return unsubscribe;
  }, [account, loadOrders, loadHistory, refreshBalance, toast]);

  const requireWallet = async () => {
    if (account) return true;
    toast.info(
      hadPreviousSession ? 'Reconnect your wallet to continue' : 'Connect your wallet to continue'
    );
    try {
      if (hadPreviousSession) await reconnect();
      else await connect();
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
    await loadOrders();
    await refreshBalance();
    try {
      await analyticsApi.syncBlockchain();
    } catch {
      // best-effort
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
    toast.info('Confirm listing in MetaMask...');

    try {
      const receipt = await listEnergy(amount, price);
      toast.success('Marketplace order created!');
      setAmount('');
      setPrice('');
      await afterChainTx(receipt);
    } catch (err) {
      toast.error(err.message || 'Failed to create listing');
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
        toast.info('Confirm purchase in MetaMask...');
      }

      const receipt = await purchaseEnergy(id);
      toast.success('Order purchased successfully!');
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
      toast.success('Order cancelled');
      await afterChainTx(receipt);
    } catch (err) {
      toast.error(err.message || 'Cancellation failed');
    } finally {
      setLoading(false);
    }
  };

  const unitPricePreview =
    amount && price && Number(amount) > 0
      ? (Number(price) / Number(amount)).toFixed(4)
      : null;

  const summaryCards = [
    {
      label: 'Active orders',
      value: (orderSummary?.totalActive ?? orders.length).toLocaleString(),
      icon: <ListOrdered size={24} className="text-emerald-400" />,
      trend: view === 'mine' ? 'Your listings' : 'Marketplace',
      positive: true,
    },
    {
      label: 'Energy listed',
      value: `${(orderSummary?.totalEnergy ?? 0).toLocaleString()} units`,
      icon: <Zap size={24} className="text-yellow-400" />,
      trend: 'Available now',
      positive: true,
    },
    {
      label: 'Order volume',
      value: `${(orderSummary?.totalVolumeCc ?? 0).toFixed(2)} CC`,
      icon: <Store size={24} className="text-blue-400" />,
      trend: `Avg ${(orderSummary?.avgUnitPrice ?? 0).toFixed(4)} CC/unit`,
      positive: true,
    },
  ];

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      <SectionTitle
        title="Energy Marketplace"
        subtitle="List energy orders and trade peer-to-peer using carbon credits."
      />

      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-slate-800/80 border border-slate-700/50 rounded-xl">
          <p className="text-slate-300 text-sm">
            {hadPreviousSession
              ? 'Reconnect MetaMask to list orders or buy energy.'
              : 'Connect MetaMask to participate in the marketplace.'}
          </p>
          <button
            type="button"
            onClick={() => (hadPreviousSession ? reconnect() : connect()).catch(() => {})}
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
            Your wallet is on the wrong network. Switch before listing or buying.
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-1 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl h-fit">
          <h3 className="text-xl font-bold text-white mb-1">Create order</h3>
          <p className="text-sm text-slate-400 mb-4">
            Post energy for sale. Buyers pay in CC when they fill your order.
          </p>
          <form onSubmit={handleListEnergy} className="space-y-4">
            <div>
              <label className="block text-slate-400 text-sm mb-1">Energy amount (units)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500"
                placeholder="e.g. 100"
                required
              />
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Total price (CC)</label>
              <input
                type="number"
                min="0.0001"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500"
                placeholder="e.g. 10"
                required
              />
              {unitPricePreview && (
                <p className="text-xs text-slate-500 mt-1">
                  Unit price: {unitPricePreview} CC per energy unit
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={loading || !account || !isCorrectNetwork}
              className="touch-target w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
            >
              {loading ? 'Processing...' : 'List on marketplace'}
            </button>
          </form>

          <div className="mt-8 pt-4 border-t border-slate-700/50">
            <p className="text-xs text-slate-500 mb-2">Dev tools (Hardhat local only)</p>
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
              Mint 100 CC to self
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl min-w-0">
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <h3 className="text-lg sm:text-xl font-bold text-white">Order book</h3>
              <button
                type="button"
                onClick={() => {
                  loadOrders();
                  toast.info('Orders refreshed');
                }}
                disabled={listingsLoading}
                className="touch-target text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex rounded-lg border border-slate-600/60 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setView('market')}
                  className={`px-4 py-2 text-sm font-medium ${
                    view === 'market'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  All orders
                </button>
                <button
                  type="button"
                  onClick={() => setView('mine')}
                  disabled={!account}
                  className={`px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                    view === 'mine'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-900/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  My listings
                </button>
              </div>

              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="bg-slate-900/70 border border-slate-600/60 rounded-lg px-3 py-2 text-sm text-slate-200 flex-1 sm:max-w-xs"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {listingsLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
              <p className="text-sm">Loading marketplace orders...</p>
            </div>
          ) : orders.length === 0 ? (
            <EmptyState
              icon={<Store size={40} />}
              title={view === 'mine' ? 'No active listings' : 'No open orders'}
              description={
                view === 'mine'
                  ? 'Create an order on the left to list energy for sale.'
                  : 'Be the first to list energy on the marketplace.'
              }
            />
          ) : (
            <div className="space-y-3">
              {orders.map((order) => (
                <MarketplaceOrderCard
                  key={order.listingId}
                  order={order}
                  account={account}
                  loading={loading}
                  isCorrectNetwork={isCorrectNetwork}
                  onPurchase={handlePurchase}
                  onCancel={handleCancel}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
          <div>
            <h3 className="text-lg sm:text-xl font-bold text-white">Transaction history</h3>
            <p className="text-sm text-slate-400 mt-1">
              {account ? 'Your indexed marketplace activity' : 'All indexed transactions'}
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
          <EmptyState
            title="No transactions yet"
            description="List or fill an order, then sync from chain."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[640px]">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="py-3 pr-4 font-medium">Type</th>
                  <th className="py-3 pr-4 font-medium">Order</th>
                  <th className="py-3 pr-4 font-medium">Energy</th>
                  <th className="py-3 pr-4 font-medium">Price (CC)</th>
                  <th className="py-3 pr-4 font-medium">Parties</th>
                  <th className="py-3 pr-4 font-medium">Block</th>
                  <th className="py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((trade) => (
                  <tr
                    key={`${trade.txHash}-${trade.logIndex}`}
                    className="border-b border-slate-700/50 text-slate-200"
                  >
                    <td className="py-3 pr-4">
                      <span
                        className={`text-xs px-2 py-1 rounded-md ${
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
