import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  Wallet,
} from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import FormField from '../components/ui/FormField';
import EmptyState from '../components/ui/EmptyState';
import TransactionSummary from '../components/ui/TransactionSummary';
import TransactionFilters from '../components/ui/TransactionFilters';
import {
  applyDirectionFilter,
  buildHistoryParams,
  classifyTrade,
  getDisplaySummary,
  parseAmount,
} from '../utils/transactionUtils';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import {
  getMarketplaceAllowance,
  mintDevTokens,
  subscribeCarbonCreditTransfers,
  transferCarbonCredits,
} from '../utils/blockchain';
import { analyticsApi, tradesApi } from '../utils/api';

const formatAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const CarbonTransactions = () => {
  const [history, setHistory] = useState([]);
  const [apiSummary, setApiSummary] = useState(null);
  const [allowance, setAllowance] = useState('0');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [transferLoading, setTransferLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [periodDays, setPeriodDays] = useState('');
  const [listingId, setListingId] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [selectedTx, setSelectedTx] = useState(null);

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState('');

  const {
    account,
    balance,
    connect,
    reconnect,
    connecting,
    hadPreviousSession,
    isCorrectNetwork,
    refreshBalance,
    ensureNetwork,
  } = useWallet();
  const toast = useToast();

  const loadAllowance = useCallback(async (wallet) => {
    if (!wallet) {
      setAllowance('0');
      return;
    }
    const value = await getMarketplaceAllowance(wallet);
    setAllowance(value);
  }, []);

  const loadHistory = useCallback(async (wallet, syncFirst = false) => {
    setHistoryLoading(true);
    try {
      const params = buildHistoryParams({
        wallet,
        filterId: filter,
        periodDays,
        listingId,
        minPrice,
        maxPrice,
        limit: 100,
      });

      const response = syncFirst
        ? await tradesApi.syncHistory(params)
        : await tradesApi.getHistory(params);

      setHistory(response.data?.trades || []);
      setApiSummary(response.data?.summary || null);
    } catch (err) {
      toast.error(err.message || 'Failed to load transaction history');
    } finally {
      setHistoryLoading(false);
    }
  }, [filter, periodDays, listingId, minPrice, maxPrice, toast]);

  const refreshAll = useCallback(async (syncFirst = false) => {
    await Promise.all([
      refreshBalance(),
      loadAllowance(account),
      loadHistory(account, syncFirst),
    ]);
  }, [account, refreshBalance, loadAllowance, loadHistory]);

  useEffect(() => {
    refreshAll(Boolean(account));
  }, [account, refreshAll, filter, periodDays, listingId, minPrice, maxPrice]);

  useEffect(() => {
    if (!account) return undefined;

    const unsubscribe = subscribeCarbonCreditTransfers(account, () => {
      refreshBalance();
      loadAllowance(account);
    });

    return unsubscribe;
  }, [account, refreshBalance, loadAllowance]);

  const filteredHistory = useMemo(
    () => applyDirectionFilter(history, filter, account),
    [history, filter, account],
  );

  const displaySummary = useMemo(
    () => getDisplaySummary(filteredHistory, account, apiSummary, filter),
    [filteredHistory, account, apiSummary, filter],
  );

  const clearFilters = () => {
    setFilter('all');
    setPeriodDays('');
    setListingId('');
    setMinPrice('');
    setMaxPrice('');
  };

  const requireWallet = async () => {
    if (account) return true;
    toast.info(hadPreviousSession ? 'Reconnect your wallet to continue' : 'Connect your wallet to continue');
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

  const handleTransfer = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!(await requireWallet()) || !(await requireCorrectNetwork())) return;

    const transferAmount = parseAmount(amount);
    if (transferAmount <= 0) {
      setFormError('Enter a valid amount greater than zero');
      return;
    }
    if (transferAmount > parseAmount(balance)) {
      setFormError('Amount exceeds your CC balance');
      return;
    }

    setTransferLoading(true);
    toast.info('Confirm transfer in MetaMask...');

    try {
      const receipt = await transferCarbonCredits(recipient.trim(), transferAmount);
      toast.success('Carbon credits transferred');
      setRecipient('');
      setAmount('');
      await refreshAll(true);
      if (receipt?.hash) {
        toast.info(`Tx: ${receipt.hash.slice(0, 10)}...`);
      }
    } catch (err) {
      toast.error(err.message || 'Transfer failed');
    } finally {
      setTransferLoading(false);
    }
  };

  const handleSync = async () => {
    try {
      await analyticsApi.syncBlockchain();
      await refreshAll(true);
      toast.success('Blockchain data synced');
    } catch (err) {
      toast.error(err.message || 'Sync failed');
    }
  };

  const copyTxHash = async (hash) => {
    try {
      await navigator.clipboard.writeText(hash);
      toast.success('Transaction hash copied');
    } catch {
      toast.error('Could not copy hash');
    }
  };

  const summaryCards = [
    {
      label: 'Wallet Balance',
      value: `${parseAmount(balance).toFixed(2)} CC`,
      icon: <Wallet size={24} className="text-emerald-400" />,
      trend: account ? formatAddress(account) : 'Not connected',
      positive: true,
    },
    {
      label: 'Credits Received',
      value: `${(displaySummary.creditsReceived || 0).toFixed(2)} CC`,
      icon: <ArrowDownLeft size={24} className="text-blue-400" />,
      trend: 'Filtered total',
      positive: true,
    },
    {
      label: 'Credits Spent',
      value: `${(displaySummary.creditsSpent || 0).toFixed(2)} CC`,
      icon: <ArrowUpRight size={24} className="text-rose-400" />,
      trend: `${displaySummary.listed || 0} listings`,
      positive: false,
    },
    {
      label: 'Net Flow',
      value: `${(displaySummary.netFlow || 0).toFixed(2)} CC`,
      icon: <Coins size={24} className="text-violet-400" />,
      trend: `${displaySummary.showing ?? 0} transactions`,
      positive: (displaySummary.netFlow || 0) >= 0,
    },
  ];

  return (
    <div className="page-section">
      <SectionTitle
        title="Carbon Credit Transactions"
        subtitle="Transfer CC tokens, review marketplace settlements, and track your on-chain credit activity."
        action={
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={historyLoading}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-50 text-white font-medium rounded-xl transition-colors w-full sm:w-auto border border-slate-600/30"
          >
            <RefreshCw size={18} className={historyLoading ? 'animate-spin' : ''} />
            {historyLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        }
      />

      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 content-card rounded-xl">
          <p className="text-slate-400 text-sm">
            Connect MetaMask to send credits and view your personal transaction ledger.
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
          <p className="text-amber-300 text-sm">Switch to the expected network before sending credits.</p>
          <button
            type="button"
            onClick={() => ensureNetwork().catch((e) => toast.error(e.message))}
            className="touch-target shrink-0 bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 font-medium px-4 py-2 rounded-xl transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        <div className="lg:col-span-1 content-card h-fit space-y-6">
          <div>
            <h3 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
              <Send size={20} className="text-emerald-400" />
              Send Credits
            </h3>
            <p className="text-sm text-slate-500">Transfer CC directly to another wallet address.</p>
          </div>

          <form onSubmit={handleTransfer} className="space-y-4">
            <FormField
              id="recipient"
              label="Recipient address"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x..."
              required
              disabled={!account || !isCorrectNetwork || transferLoading}
            />
            <FormField
              id="amount"
              label="Amount (CC)"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 25"
              required
              disabled={!account || !isCorrectNetwork || transferLoading}
              error={formError}
              hint={`Available: ${parseAmount(balance).toFixed(2)} CC`}
            />
            <button
              type="submit"
              disabled={transferLoading || !account || !isCorrectNetwork}
              className="touch-target w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:from-slate-600 disabled:to-slate-700 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-all duration-200 shadow-lg shadow-emerald-500/15"
            >
              {transferLoading ? 'Sending...' : 'Send Carbon Credits'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-700/30 space-y-3">
            <div className="bg-slate-900/40 p-3.5 rounded-xl border border-slate-700/30 text-sm">
              <p className="text-slate-500 text-xs uppercase tracking-wider">Marketplace allowance</p>
              <p className="text-white font-semibold mt-1.5">{parseAmount(allowance).toFixed(2)} CC</p>
              <p className="text-[11px] text-slate-600 mt-1.5">
                Approved for the energy trading contract to settle purchases.
              </p>
            </div>

            <Link
              to="/trading"
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-slate-600/40 text-slate-300 hover:bg-slate-700/30 text-sm font-medium transition-colors"
            >
              <Coins size={16} />
              Open Energy Marketplace
            </Link>

            <button
              type="button"
              onClick={handleSync}
              className="w-full py-2.5 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm transition-colors border border-slate-600/20"
            >
              Sync blockchain ledger
            </button>

            <div>
              <p className="text-[10px] text-slate-600 mb-2 uppercase tracking-wider">Dev tools</p>
              <button
                type="button"
                onClick={() =>
                  mintDevTokens(100)
                    .then(() => {
                      toast.success('Minted 100 CC');
                      refreshAll();
                    })
                    .catch((e) => toast.error(e.message))
                }
                disabled={!account || !isCorrectNetwork}
                className="w-full bg-slate-700/40 hover:bg-slate-600/40 disabled:opacity-50 text-slate-400 text-sm py-2 rounded-xl border border-slate-600/20 transition-colors"
              >
                Mint 100 CC to self
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 content-card min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
            <div>
              <h3 className="text-lg sm:text-xl font-bold text-white">Credit Activity Ledger</h3>
              <p className="text-sm text-slate-500 mt-1">
                Indexed marketplace settlements mapped to carbon credit flows.
              </p>
            </div>
          </div>

          <TransactionFilters
            filterId={filter}
            onFilterChange={setFilter}
            periodDays={periodDays}
            onPeriodChange={setPeriodDays}
            listingId={listingId}
            onListingIdChange={setListingId}
            minPrice={minPrice}
            onMinPriceChange={setMinPrice}
            maxPrice={maxPrice}
            onMaxPriceChange={setMaxPrice}
            onClear={clearFilters}
          />

          <TransactionSummary summary={displaySummary} wallet={account} />

          {historyLoading && filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
              <div className="relative">
                <div className="absolute inset-0 bg-emerald-500/15 rounded-full blur-lg animate-pulse" />
                <Loader2 className="relative h-7 w-7 animate-spin text-emerald-500" />
              </div>
              <p className="text-sm">Loading transactions...</p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <EmptyState
              illustration="credits"
              title="No credit activity yet"
              description="Complete an energy trade or sync from chain to populate your ledger."
              actionTo="/trading"
              actionLabel="Go to Marketplace"
            />
          ) : (
            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full text-sm text-left min-w-[720px]">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-700/40">
                    <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Activity</th>
                    <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">CC impact</th>
                    <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Counterparty</th>
                    <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Listing</th>
                    <th className="py-3 pr-4 font-medium text-xs uppercase tracking-wider">Tx hash</th>
                    <th className="py-3 font-medium text-xs uppercase tracking-wider">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((trade) => {
                    const info = classifyTrade(trade, account);
                    const counterparty =
                      info.direction === 'sent'
                        ? trade.seller
                        : info.direction === 'received'
                          ? trade.buyer
                          : trade.buyer || trade.seller;

                    return (
                      <tr
                        key={`${trade.txHash}-${trade.logIndex}`}
                        onClick={() => setSelectedTx(trade)}
                        className="border-b border-slate-700/20 text-slate-200 hover:bg-slate-800/30 cursor-pointer transition-colors"
                      >
                        <td className="py-3 pr-4">
                          <span
                            className={`text-xs px-2 py-1 rounded-lg font-medium ${
                              info.direction === 'received'
                                ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                                : info.direction === 'sent'
                                  ? 'bg-rose-500/10 text-rose-300 border border-rose-500/20'
                                  : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'
                            }`}
                          >
                            {info.label}
                          </span>
                        </td>
                        <td className="py-3 pr-4 font-medium font-mono">
                          {info.direction === 'received' && info.amount > 0 && (
                            <span className="text-emerald-400">+{info.amount.toFixed(2)} CC</span>
                          )}
                          {info.direction === 'sent' && info.amount > 0 && (
                            <span className="text-rose-400">-{info.amount.toFixed(2)} CC</span>
                          )}
                          {info.direction === 'marketplace' && (
                            <span className="text-slate-400">
                              {info.amount > 0 ? `${info.amount.toFixed(2)} CC listed` : '—'}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs">{formatAddress(counterparty)}</td>
                        <td className="py-3 pr-4 font-mono">#{trade.listingId}</td>
                        <td className="py-3 pr-4">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyTxHash(trade.txHash);
                            }}
                            className="inline-flex items-center gap-1 font-mono text-xs text-slate-500 hover:text-emerald-400 transition-colors"
                          >
                            {formatAddress(trade.txHash)}
                            <Copy size={12} />
                          </button>
                        </td>
                        <td className="py-3 text-slate-500 text-xs">{formatDate(trade.blockTimestamp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedTx && (
        <div className="content-card animate-fade-in-up">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Transaction details</h3>
              <p className="text-sm text-slate-500 mt-1 font-mono break-all">{selectedTx.txHash}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTx(null)}
              className="text-slate-500 hover:text-white text-sm transition-colors"
            >
              Close
            </button>
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="bg-slate-900/40 p-3.5 rounded-xl border border-slate-700/30">
              <dt className="text-slate-500 text-xs uppercase tracking-wider">Event</dt>
              <dd className="text-white font-medium mt-1.5 capitalize">{selectedTx.eventType}</dd>
            </div>
            <div className="bg-slate-900/40 p-3.5 rounded-xl border border-slate-700/30">
              <dt className="text-slate-500 text-xs uppercase tracking-wider">Energy</dt>
              <dd className="text-white font-medium mt-1.5">{selectedTx.energyAmount || '—'}</dd>
            </div>
            <div className="bg-slate-900/40 p-3.5 rounded-xl border border-slate-700/30">
              <dt className="text-slate-500 text-xs uppercase tracking-wider">Price (CC)</dt>
              <dd className="text-emerald-400 font-medium mt-1.5 font-mono">{selectedTx.price || '—'}</dd>
            </div>
            <div className="bg-slate-900/40 p-3.5 rounded-xl border border-slate-700/30">
              <dt className="text-slate-500 text-xs uppercase tracking-wider">Block</dt>
              <dd className="text-white font-medium mt-1.5 font-mono">{selectedTx.blockNumber ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => copyTxHash(selectedTx.txHash)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 text-sm text-white transition-colors border border-slate-600/20"
            >
              <Copy size={14} />
              Copy hash
            </button>
            <Link
              to="/trading"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600/30 text-sm text-slate-300 hover:bg-slate-700/30 transition-colors"
            >
              <ExternalLink size={14} />
              View marketplace
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default CarbonTransactions;
