import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchAllListings,
  listEnergy,
  purchaseEnergy,
  cancelListing,
  approveTokensIfNeeded,
  mintDevTokens,
  DEV_MINT_ENABLED,
  createEscrow,
} from '../utils/blockchain';
import { marketplaceApi, tradesApi, analyticsApi, nodesApi, pricingApi } from '../utils/api';
import { useSocketEvent, useSocketReconnect } from '../context/SocketContext';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import MarketplaceOrderCard from '../components/ui/MarketplaceOrderCard';
import EmptyState from '../components/ui/EmptyState';
import RatingModal from '../components/ui/RatingModal';
import SettlementStatusTimeline from '../components/settlement/SettlementStatusTimeline';
import EnergyFlowSankey from '../components/trading/EnergyFlowSankey';
import LiveTradeTicker from '../components/trading/LiveTradeTicker';
import TransactionSummary from '../components/ui/TransactionSummary';
import TransactionFilters from '../components/ui/TransactionFilters';
import {
  applyDirectionFilter,
  buildHistoryParams,
  getDisplaySummary,
  EVENT_LABELS,
} from '../utils/transactionUtils';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import { Loader2, Store, ListOrdered, Zap, Sparkles, Star } from 'lucide-react';

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

const DepthSide = ({ title, levels, barClass, textClass, valueKey }) => {
  const safe = Array.isArray(levels) ? levels : [];
  const maxEnergy = safe.reduce((m, l) => Math.max(m, Number(l.energyKw) || 0), 0) || 1;
  return (
    <div>
      <div className="flex justify-between text-slate-500 mb-1">
        <span>{title}</span>
        <span>price (CC/kWh) · energy (kWh)</span>
      </div>
      <div className="space-y-1">
        {safe.length === 0 ? (
          <p className="text-slate-600">No levels</p>
        ) : (
          safe.map((lvl, i) => {
            const widthPct = Math.max(4, Math.round(((Number(lvl.energyKw) || 0) / maxEnergy) * 100));
            return (
              <div key={`${valueKey}-${i}`} className="relative rounded">
                <div
                  className={`absolute inset-y-0 right-0 ${barClass} rounded`}
                  style={{ width: `${widthPct}%` }}
                />
                <div className="relative flex justify-between px-2 py-0.5">
                  <span className={`font-medium ${textClass}`}>
                    {Number(lvl[valueKey]).toFixed(4)}
                  </span>
                  <span className="text-slate-300">{(Number(lvl.energyKw) || 0).toFixed(2)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const Trading = () => {
  const [orders, setOrders] = useState([]);
  const [orderSummary, setOrderSummary] = useState(null);
  const [depth, setDepth] = useState(null);
  const [depthLoading, setDepthLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [apiSummary, setApiSummary] = useState(null);
  const [txFilter, setTxFilter] = useState('all');
  const [txPeriodDays, setTxPeriodDays] = useState('');
  const [txListingId, setTxListingId] = useState('');
  const [txMinPrice, setTxMinPrice] = useState('');
  const [txMaxPrice, setTxMaxPrice] = useState('');
  const [listingsLoading, setListingsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('market');
  const [sort, setSort] = useState('newest');

  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');

  // Sub-module 2.2 — forecast-derived listing suggestion.
  const [nodes, setNodes] = useState([]);
  const [listNodeId, setListNodeId] = useState('');
  const [recommendation, setRecommendation] = useState(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);

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
  const [ratingTarget, setRatingTarget] = useState(null);
  const [settlementTarget, setSettlementTarget] = useState(null);
  const [ratedTrades, setRatedTrades] = useState(() => new Set());

  const handleSubmitRating = async (body) => {
    const res = await marketplaceApi.submitRating(body);
    setRatedTrades((prev) => {
      const next = new Set(prev);
      next.add(body.tradeTxHash);
      return next;
    });
    toast.success('Rating submitted. Thank you!');
    return res;
  };

  const loadOrders = useCallback(async () => {
    setListingsLoading(true);

    const params = { sort, limit: 100 };
    if (view === 'mine' && account) {
      params.seller = account;
    }

    const mapFallback = (fallback) => {
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

      return mapped;
    };

    const applyMapped = (mapped) => {
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
    };

    const applyApiSnapshot = (payload) => {
      setOrders(payload?.orders || []);
      setOrderSummary(payload?.summary || null);
    };

    try {
      try {
        const response = await marketplaceApi.getOrders(params);
        const apiOrders = response?.data?.orders;
        if (Array.isArray(apiOrders) && apiOrders.length > 0) {
          applyApiSnapshot(response.data);
          return;
        }

        if (Array.isArray(apiOrders) && apiOrders.length === 0) {
          // If backend returns empty while chain has fresh listings, use wallet RPC snapshot.
          // This keeps UI responsive when backend indexing lags right after deploy/tx.
          try {
            const walletOrders = await fetchAllListings().then(mapFallback);
            if (walletOrders.length > 0) {
              applyMapped(walletOrders);
              return;
            }
          } catch {
            // Ignore and fall back to API snapshot below.
          }

          applyApiSnapshot(response.data);
          return;
        }
      } catch {
        // Fall back to wallet RPC below.
      }

      try {
        const walletOrders = await fetchAllListings().then(mapFallback);
        applyMapped(walletOrders);
      } catch {
        setOrders([]);
        setOrderSummary(null);
      }
    } finally {
      setListingsLoading(false);
    }
  }, [account, sort, view]);

  // Order-book depth ladder (Sub-module 6.1). Refreshed on mount and on the
  // orderbookUpdate socket push (debounced — the sync pass can fire bursts).
  const depthRefreshTimer = useRef(null);
  const loadDepth = useCallback(async () => {
    setDepthLoading(true);
    try {
      const response = await marketplaceApi.getOrderBookDepth({ buckets: 20 });
      setDepth(response?.data || null);
    } catch {
      setDepth(null);
    } finally {
      setDepthLoading(false);
    }
  }, []);

  const scheduleDepthRefresh = useCallback(() => {
    if (depthRefreshTimer.current) clearTimeout(depthRefreshTimer.current);
    depthRefreshTimer.current = setTimeout(() => {
      loadDepth();
    }, 600);
  }, [loadDepth]);

  useEffect(() => {
    loadDepth();
  }, [loadDepth]);

  const loadHistory = useCallback(async (wallet, syncFirst = false) => {
    setHistoryLoading(true);
    const params = buildHistoryParams({
      wallet,
      filterId: txFilter,
      periodDays: txPeriodDays,
      listingId: txListingId,
      minPrice: txMinPrice,
      maxPrice: txMaxPrice,
      limit: 100,
    });

    try {
      if (syncFirst) {
        const response = await tradesApi.syncHistory(params);
        const sync = response.data?.sync;

        if (sync?.skipped && sync?.message === 'Sync already in progress') {
          const fallback = await tradesApi.getHistory(params);
          setHistory(fallback.data?.trades || []);
          setApiSummary(fallback.data?.summary || null);
          return;
        }

        setHistory(response?.data?.trades || []);
        setApiSummary(response?.data?.summary || null);
        if (sync?.skipped && sync?.message) {
          toast.error(sync.message);
        }
      } else {
        const response = await tradesApi.getHistory(params);
        setHistory(response.data?.trades || []);
        setApiSummary(response.data?.summary || null);
      }
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
        try {
          const fallback = await tradesApi.getHistory(params);
          setHistory(fallback.data?.trades || []);
          setApiSummary(fallback.data?.summary || null);
        } catch {
          toast.error(err.message || 'Failed to sync transaction history');
        }
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [txFilter, txPeriodDays, txListingId, txMinPrice, txMaxPrice, toast]);

  const filteredHistory = React.useMemo(
    () => applyDirectionFilter(history, txFilter, account),
    [history, txFilter, account],
  );

  const txDisplaySummary = React.useMemo(
    () => getDisplaySummary(filteredHistory, account, apiSummary, txFilter),
    [filteredHistory, account, apiSummary, txFilter],
  );

  const clearTxFilters = () => {
    setTxFilter('all');
    setTxPeriodDays('');
    setTxListingId('');
    setTxMinPrice('');
    setTxMaxPrice('');
  };

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    loadHistory(account, false);
  }, [account, loadHistory]);

  // Load owned nodes for the suggestion picker (Sub-module 2.2).
  useEffect(() => {
    let cancelled = false;
    const loadNodes = async () => {
      try {
        const res = await nodesApi.getAll();
        if (cancelled) return;
        const list = res.data || [];
        setNodes(list);
        if (list.length > 0) setListNodeId(list[0]._id);
      } catch {
        if (!cancelled) setNodes([]);
      }
    };
    loadNodes();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch a surplus listing recommendation whenever the selected node changes.
  useEffect(() => {
    if (!listNodeId) {
      setRecommendation(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setRecommendationLoading(true);
      try {
        const res = await pricingApi.getRecommendation({ nodeId: listNodeId });
        if (!cancelled) setRecommendation(res.data || null);
      } catch {
        if (!cancelled) setRecommendation(null);
      } finally {
        if (!cancelled) setRecommendationLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [listNodeId]);

  useSocketReconnect(() => {
    loadOrders();
    if (account) {
      loadHistory(account, true);
    }
    toast.info('Live connection restored — marketplace synced');
  });

  useSocketEvent(SOCKET_EVENTS.SERVER.BLOCKCHAIN_EVENT, (data) => {
    loadOrders();
    refreshBalance();
    // The backend already syncs to MongoDB before broadcasting this event, so a
    // plain (non-syncing) history fetch is enough — no extra re-sync needed.
    if (account) {
      loadHistory(account, false);
    }

    if (data.eventType === 'listed') {
      toast.info(`New marketplace order listed: #${data.listingId}`);
    } else if (data.eventType === 'purchased') {
      toast.success(`Order #${data.listingId} filled on-chain!`);
    } else if (data.eventType === 'cancelled') {
      toast.info(`Order #${data.listingId} cancelled`);
    }
  });

  useSocketEvent(SOCKET_EVENTS.SERVER.ORDERBOOK_UPDATE, () => {
    // Compact diff signal (Sub-module 6.1.4) — refetch the visible book + depth.
    loadOrders();
    scheduleDepthRefresh();
  });

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
    await Promise.all([loadOrders(), refreshBalance()]);
    // Trigger exactly one chain sync. loadHistory(syncFirst) already calls the
    // sync endpoint, so we avoid stacking a second full re-sync here (stacked
    // syncs compete for the same rate-limited RPC and slow everything down).
    if (account) {
      loadHistory(account, true).catch(() => {});
    } else {
      analyticsApi.syncBlockchain().catch(() => {});
    }
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
      setSettlementTarget({ txHash: receipt?.hash, listingId: id });
    } catch (err) {
      toast.error(err.message || 'Purchase failed');
    } finally {
      setLoading(false);
    }
  };

  // Module 5.1 — conditional settlement: lock funds in escrow instead of an
  // instant transfer. The buyer can later release, dispute, or claim a refund.
  const handlePurchaseViaEscrow = async (order) => {
    if (!(await requireWallet()) || !(await requireCorrectNetwork())) return;

    setLoading(true);
    try {
      toast.info('Confirm escrow funding in MetaMask (approval + deposit)...');
      const receipt = await createEscrow(order.listingId, order.seller, order.price);
      toast.success('Funds locked in escrow. Confirm delivery before releasing.');
      await afterChainTx(receipt);
      setSettlementTarget({ txHash: receipt?.hash, listingId: order.listingId });
    } catch (err) {
      toast.error(err.message || 'Escrow purchase failed');
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

  const recommendationExpired =
    recommendation?.expiresAt && new Date(recommendation.expiresAt).getTime() <= Date.now();

  const applySuggestion = () => {
    if (!recommendation || !recommendation.eligible || recommendationExpired) return;
    setAmount(String(recommendation.energyAmount));
    setPrice(String(recommendation.totalPriceCc));
    toast.info('Suggested amount and price applied from forecast');
  };

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
    <div className="page-section">
      <SectionTitle
        title="Energy Marketplace"
        subtitle="List energy orders and trade peer-to-peer using carbon credits."
      />

      <LiveTradeTicker />

      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 content-card rounded-xl">
          <p className="text-slate-400 text-sm">
            {hadPreviousSession
              ? 'Reconnect MetaMask to list orders or buy energy.'
              : 'Connect MetaMask to participate in the marketplace.'}
          </p>
          <button
            type="button"
            onClick={() => (hadPreviousSession ? reconnect() : connect()).catch(() => {})}
            disabled={connecting}
            className="touch-target shrink-0 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-xl transition-all duration-200 shadow-lg shadow-emerald-500/15"
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        </div>
      )}

      {account && !isCorrectNetwork && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
          <p className="text-amber-300 text-sm">
            Your wallet is on the wrong network. Switch before listing or buying.
          </p>
          <button
            type="button"
            onClick={() => ensureNetwork().catch((e) => toast.error(e.message))}
            className="touch-target shrink-0 bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 font-medium px-4 py-2 rounded-xl transition-colors"
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        <div className="lg:col-span-1 content-card h-fit">
          <h3 className="text-xl font-bold text-white mb-1">Create order</h3>
          <p className="text-sm text-slate-500 mb-5">
            Post energy for sale. Buyers pay in CC when they fill your order.
          </p>
          <form onSubmit={handleListEnergy} className="space-y-4">
            {nodes.length > 0 && (
              <div>
                <label className="block text-slate-400 text-sm mb-1">Source node (for suggestion)</label>
                <select
                  value={listNodeId}
                  onChange={(e) => setListNodeId(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-emerald-500"
                >
                  {nodes.map((node) => (
                    <option key={node._id} value={node._id}>
                      {node.name} ({node.nodeType})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {listNodeId && (
              <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                {recommendationLoading ? (
                  <p className="text-xs text-slate-500 flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> Calculating forecast suggestion...
                  </p>
                ) : recommendation ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-emerald-300">
                        <Sparkles size={16} />
                        <span className="text-sm font-semibold">Forecast suggestion</span>
                      </div>
                      {recommendation.eligible && !recommendationExpired && (
                        <button
                          type="button"
                          onClick={applySuggestion}
                          className="touch-target text-xs font-medium px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                        >
                          Use suggestion
                        </button>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400">
                      <span>Surplus: <span className="text-slate-200 font-mono">{recommendation.surplus.totalSurplusKwh} kWh</span></span>
                      <span>Unit: <span className="text-slate-200 font-mono">{recommendation.unitPriceCc} CC/kWh</span></span>
                      <span>Total: <span className="text-slate-200 font-mono">{recommendation.totalPriceCc} CC</span></span>
                      <span>Valid until: <span className="text-slate-200 font-mono">{recommendationExpired ? 'expired' : new Date(recommendation.expiresAt).toLocaleTimeString()}</span></span>
                    </div>
                    {!recommendation.eligible && (
                      <p className="mt-2 text-xs text-amber-300">
                        {recommendation.reasons.join('; ')}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-slate-600">{recommendation.disclaimer}</p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">No suggestion available for this node.</p>
                )}
              </div>
            )}

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

          {DEV_MINT_ENABLED && (
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
          )}
        </div>

        <div className="lg:col-span-2 content-card min-w-0">
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

          {depth && view === 'market' && (
            <div className="mb-6 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-slate-200">Market depth</h4>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>
                    Mid:{' '}
                    <span className="text-slate-100 font-medium">
                      {depth.midUnitPriceCc ? depth.midUnitPriceCc.toFixed(4) : '—'}
                    </span>
                  </span>
                  <span>
                    Spread:{' '}
                    <span className="text-slate-100 font-medium">
                      {depth.spreadCc != null ? depth.spreadCc.toFixed(4) : '—'}
                    </span>
                  </span>
                  <span>
                    Best ask:{' '}
                    <span className="text-rose-300 font-medium">
                      {depth.asks?.bestAskUnitPriceCc ? depth.asks.bestAskUnitPriceCc.toFixed(4) : '—'}
                    </span>
                  </span>
                  <span>
                    Best bid:{' '}
                    <span className="text-emerald-300 font-medium">
                      {depth.bids?.bestBidUnitPriceCc ? depth.bids.bestBidUnitPriceCc.toFixed(4) : '—'}
                    </span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <DepthSide
                  title="Asks (sell)"
                  levels={(depth.asks?.levels || []).slice().reverse().slice(0, 8)}
                  barClass="bg-rose-500/25"
                  textClass="text-rose-300"
                  valueKey="unitPriceCc"
                />
                <DepthSide
                  title="Bids (buy)"
                  levels={(depth.bids?.levels || []).slice(0, 8)}
                  barClass="bg-emerald-500/25"
                  textClass="text-emerald-300"
                  valueKey="unitPriceCc"
                />
              </div>
              {depthLoading && (
                <p className="text-[10px] text-slate-500 mt-2">Refreshing depth…</p>
              )}
            </div>
          )}

          {listingsLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-3">
              <div className="relative">
                <div className="absolute inset-0 bg-emerald-500/15 rounded-full blur-lg animate-pulse" />
                <Loader2 className="relative h-8 w-8 animate-spin text-emerald-500" />
              </div>
              <p className="text-sm">Loading marketplace orders...</p>
            </div>
          ) : orders.length === 0 ? (
            <EmptyState
              illustration="trading"
              title={view === 'mine' ? 'No active listings' : 'No open orders'}
              description={
                view === 'mine'
                  ? 'Create an order to list energy for sale.'
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
                  onPurchaseEscrow={handlePurchaseViaEscrow}
                  onCancel={handleCancel}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="content-card">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
          <div>
            <h3 className="text-lg sm:text-xl font-bold text-white">Transaction history</h3>
            <p className="text-sm text-slate-500 mt-1">
              {account ? 'Your indexed marketplace activity' : 'All indexed transactions'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadHistory(account, true)}
            disabled={historyLoading}
            className="touch-target text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2 disabled:opacity-50 transition-colors"
          >
            {historyLoading ? 'Syncing...' : 'Sync from chain'}
          </button>
        </div>

        <TransactionFilters
          filterId={txFilter}
          onFilterChange={setTxFilter}
          periodDays={txPeriodDays}
          onPeriodChange={setTxPeriodDays}
          listingId={txListingId}
          onListingIdChange={setTxListingId}
          minPrice={txMinPrice}
          onMinPriceChange={setTxMinPrice}
          maxPrice={txMaxPrice}
          onMaxPriceChange={setTxMaxPrice}
          onClear={clearTxFilters}
        />

        <TransactionSummary summary={txDisplaySummary} wallet={account} compact />

        {historyLoading && filteredHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/15 rounded-full blur-lg animate-pulse" />
              <Loader2 className="relative h-7 w-7 animate-spin text-emerald-500" />
            </div>
            <p className="text-sm">Loading transaction history...</p>
          </div>
        ) : filteredHistory.length === 0 ? (
          <EmptyState
            illustration="transactions"
            title="No transactions match filters"
            description="Adjust filters or sync from chain to load more activity."
          />
        ) : (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm text-left min-w-[640px]">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700/50">
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Type</th>
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Order</th>
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Energy</th>
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Price (CC)</th>
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Parties</th>
                  <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Block</th>
                  <th className="py-3 font-medium text-xs uppercase tracking-wider">Time</th>
                  <th className="py-3 pl-4 font-medium text-xs uppercase tracking-wider">Rate</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((trade) => (
                  <tr
                    key={`${trade.txHash}-${trade.logIndex}`}
                    className="border-b border-slate-700/30 text-slate-200 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="py-3 pr-4">
                      <span
                        className={`text-xs px-2 py-1 rounded-lg font-medium ${
                          trade.eventType === 'purchased'
                            ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20'
                            : trade.eventType === 'cancelled'
                              ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                              : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                        }`}
                      >
                        {EVENT_LABELS[trade.eventType] || trade.eventType}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-mono">#{trade.listingId}</td>
                    <td className="py-3 pr-4">{trade.energyAmount || '—'}</td>
                    <td className="py-3 pr-4 font-mono">{trade.price !== '0' ? trade.price : '—'}</td>
                    <td className="py-3 pr-4 font-mono text-xs">
                      <div>S: {formatAddress(trade.seller)}</div>
                      {trade.buyer && <div>B: {formatAddress(trade.buyer)}</div>}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">{trade.blockNumber ?? '—'}</td>
                    <td className="py-3 text-slate-400 text-xs">{formatDate(trade.blockTimestamp)}</td>
                    <td className="py-3 pl-4">
                      {trade.eventType === 'purchased' &&
                      trade.buyer &&
                      account &&
                      trade.buyer.toLowerCase() === account.toLowerCase() ? (
                        ratedTrades.has(trade.txHash) ? (
                          <span className="text-xs text-emerald-400/70 inline-flex items-center gap-1">
                            <Star size={12} className="fill-emerald-400/70" />
                            Rated
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setRatingTarget({
                                tradeTxHash: trade.txHash,
                                ratedWallet: trade.seller,
                                listingId: trade.listingId,
                              })
                            }
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                          >
                            <Star size={12} />
                            Rate seller
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RatingModal
        open={!!ratingTarget}
        onClose={() => setRatingTarget(null)}
        onSubmit={handleSubmitRating}
        tradeTxHash={ratingTarget?.tradeTxHash}
        ratedWallet={ratingTarget?.ratedWallet}
        listingId={ratingTarget?.listingId}
      />

      <EnergyFlowSankey />

      {settlementTarget && (
        <SettlementStatusTimeline
          txHash={settlementTarget.txHash}
          listingId={settlementTarget.listingId}
          onClose={() => setSettlementTarget(null)}
        />
      )}
    </div>
  );
};

export default Trading;
