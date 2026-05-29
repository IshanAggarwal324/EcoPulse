import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Copy,
  ExternalLink,
  RefreshCw,
  Send,
  Wallet,
} from 'lucide-react';
import SectionTitle from '../components/ui/SectionTitle';
import SummaryCard from '../components/ui/SummaryCard';
import FormField from '../components/ui/FormField';
import EmptyState from '../components/ui/EmptyState';
import { useToast } from '../context/ToastContext';
import { useWallet } from '../context/WalletContext';
import {
  getMarketplaceAllowance,
  mintDevTokens,
  subscribeCarbonCreditTransfers,
  transferCarbonCredits,
} from '../utils/blockchain';
import { analyticsApi, tradesApi } from '../utils/api';

const FILTER_OPTIONS = [
  { id: 'all', label: 'All activity' },
  { id: 'received', label: 'Received' },
  { id: 'sent', label: 'Sent' },
  { id: 'marketplace', label: 'Marketplace' },
];

const formatAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const parseAmount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const classifyTrade = (trade, wallet) => {
  if (!wallet) return { direction: 'neutral', label: 'Marketplace' };

  const me = wallet.toLowerCase();
  const seller = trade.seller?.toLowerCase();
  const buyer = trade.buyer?.toLowerCase();

  if (trade.eventType === 'purchased' && buyer === me) {
    return { direction: 'sent', label: 'Energy purchase', amount: parseAmount(trade.price) };
  }
  if (trade.eventType === 'purchased' && seller === me) {
    return { direction: 'received', label: 'Sale proceeds', amount: parseAmount(trade.price) };
  }
  if (trade.eventType === 'listed' && seller === me) {
    return { direction: 'marketplace', label: 'Listing created', amount: parseAmount(trade.price) };
  }
  if (trade.eventType === 'cancelled' && seller === me) {
    return { direction: 'marketplace', label: 'Listing cancelled', amount: 0 };
  }

  return { direction: 'marketplace', label: 'Marketplace', amount: parseAmount(trade.price) };
};

const CarbonTransactions = () => {
  const [history, setHistory] = useState([]);
  const [allowance, setAllowance] = useState('0');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [transferLoading, setTransferLoading] = useState(false);
  const [filter, setFilter] = useState('all');
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
      const params = { limit: 50 };
      if (wallet) params.wallet = wallet;

      const response = syncFirst
        ? await tradesApi.syncHistory(params)
        : await tradesApi.getHistory(params);

      setHistory(response.data?.trades || []);
    } catch (err) {
      toast.error(err.message || 'Failed to load transaction history');
    } finally {
      setHistoryLoading(false);
    }
  }, [toast]);

  const refreshAll = useCallback(async (syncFirst = false) => {
    await Promise.all([
      refreshBalance(),
      loadAllowance(account),
      loadHistory(account, syncFirst),
    ]);
  }, [account, refreshBalance, loadAllowance, loadHistory]);

  useEffect(() => {
    refreshAll(Boolean(account));
  }, [account, refreshAll]);

  useEffect(() => {
    if (!account) return undefined;

    const unsubscribe = subscribeCarbonCreditTransfers(account, () => {
      refreshBalance();
      loadAllowance(account);
    });

    return unsubscribe;
  }, [account, refreshBalance, loadAllowance]);

  const ledgerStats = useMemo(() => {
    if (!account) return { received: 0, sent: 0, marketplace: 0 };

    return history.reduce(
      (acc, trade) => {
        const info = classifyTrade(trade, account);
        if (info.direction === 'received') acc.received += info.amount;
        if (info.direction === 'sent') acc.sent += info.amount;
        if (info.direction === 'marketplace') acc.marketplace += 1;
        return acc;
      },
      { received: 0, sent: 0, marketplace: 0 },
    );
  }, [history, account]);

  const filteredHistory = useMemo(() => {
    if (filter === 'all') return history;
    return history.filter((trade) => classifyTrade(trade, account).direction === filter);
  }, [history, filter, account]);

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
      value: `${ledgerStats.received.toFixed(2)} CC`,
      icon: <ArrowDownLeft size={24} className="text-blue-400" />,
      trend: 'From marketplace sales',
      positive: true,
    },
    {
      label: 'Credits Spent',
      value: `${ledgerStats.sent.toFixed(2)} CC`,
      icon: <ArrowUpRight size={24} className="text-rose-400" />,
      trend: `${ledgerStats.marketplace} listing events`,
      positive: false,
    },
  ];

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      <SectionTitle
        title="Carbon Credit Transactions"
        subtitle="Transfer CC tokens, review marketplace settlements, and track your on-chain credit activity."
        action={
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={historyLoading}
            className="touch-target flex items-center gap-2 px-5 py-3 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium rounded-lg transition-colors w-full sm:w-auto"
          >
            <RefreshCw size={18} className={historyLoading ? 'animate-spin' : ''} />
            {historyLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        }
      />

      {!account && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-slate-800/80 border border-slate-700/50 rounded-xl">
          <p className="text-slate-300 text-sm">
            Connect MetaMask to send credits and view your personal transaction ledger.
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
          <p className="text-amber-200 text-sm">Switch to the expected network before sending credits.</p>
          <button
            type="button"
            onClick={() => ensureNetwork().catch((e) => toast.error(e.message))}
            className="touch-target shrink-0 bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30 font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-1 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl h-fit space-y-6">
          <div>
            <h3 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
              <Send size={20} className="text-emerald-400" />
              Send Credits
            </h3>
            <p className="text-sm text-slate-400">Transfer CC directly to another wallet address.</p>
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
              className="touch-target w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
            >
              {transferLoading ? 'Sending...' : 'Send Carbon Credits'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-700/50 space-y-3">
            <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 text-sm">
              <p className="text-slate-400">Marketplace allowance</p>
              <p className="text-white font-semibold mt-1">{parseAmount(allowance).toFixed(2)} CC</p>
              <p className="text-xs text-slate-500 mt-1">
                Approved for the energy trading contract to settle purchases.
              </p>
            </div>

            <Link
              to="/trading"
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700/50 text-sm font-medium transition-colors"
            >
              <Coins size={16} />
              Open Energy Marketplace
            </Link>

            <button
              type="button"
              onClick={handleSync}
              className="w-full py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm transition-colors"
            >
              Sync blockchain ledger
            </button>

            <div>
              <p className="text-xs text-slate-500 mb-2">Dev tools (Hardhat local only)</p>
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
                className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-300 text-sm py-2 rounded-lg"
              >
                Mint 100 CC to self
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
            <div>
              <h3 className="text-lg sm:text-xl font-bold text-white">Credit Activity Ledger</h3>
              <p className="text-sm text-slate-400 mt-1">
                Indexed marketplace settlements mapped to carbon credit flows.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    filter === option.id
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-slate-900/60 text-slate-400 border border-slate-700/50 hover:text-slate-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {historyLoading && filteredHistory.length === 0 ? (
            <p className="text-slate-400 text-center py-12">Loading transactions...</p>
          ) : filteredHistory.length === 0 ? (
            <EmptyState
              icon={<Coins size={40} />}
              title="No credit activity yet"
              description="Complete an energy trade or sync from chain to populate your ledger."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left min-w-[720px]">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-700">
                    <th className="py-3 pr-4 font-medium">Activity</th>
                    <th className="py-3 pr-4 font-medium">CC impact</th>
                    <th className="py-3 pr-4 font-medium">Counterparty</th>
                    <th className="py-3 pr-4 font-medium">Listing</th>
                    <th className="py-3 pr-4 font-medium">Tx hash</th>
                    <th className="py-3 font-medium">Time</th>
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
                        className="border-b border-slate-700/50 text-slate-200 hover:bg-slate-900/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 pr-4">
                          <span
                            className={`text-xs px-2 py-1 rounded-md ${
                              info.direction === 'received'
                                ? 'bg-emerald-500/10 text-emerald-300'
                                : info.direction === 'sent'
                                  ? 'bg-rose-500/10 text-rose-300'
                                  : 'bg-slate-500/10 text-slate-300'
                            }`}
                          >
                            {info.label}
                          </span>
                        </td>
                        <td className="py-3 pr-4 font-medium">
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
                        <td className="py-3 pr-4">#{trade.listingId}</td>
                        <td className="py-3 pr-4">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyTxHash(trade.txHash);
                            }}
                            className="inline-flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-emerald-400"
                          >
                            {formatAddress(trade.txHash)}
                            <Copy size={12} />
                          </button>
                        </td>
                        <td className="py-3 text-slate-400">{formatDate(trade.blockTimestamp)}</td>
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
        <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-4 sm:p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="text-lg font-bold text-white">Transaction details</h3>
              <p className="text-sm text-slate-400 mt-1 font-mono break-all">{selectedTx.txHash}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTx(null)}
              className="text-slate-400 hover:text-white text-sm"
            >
              Close
            </button>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
              <dt className="text-slate-400">Event</dt>
              <dd className="text-white font-medium mt-1 capitalize">{selectedTx.eventType}</dd>
            </div>
            <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
              <dt className="text-slate-400">Energy amount</dt>
              <dd className="text-white font-medium mt-1">{selectedTx.energyAmount || '—'}</dd>
            </div>
            <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
              <dt className="text-slate-400">Price (CC)</dt>
              <dd className="text-emerald-400 font-medium mt-1">{selectedTx.price || '—'}</dd>
            </div>
            <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
              <dt className="text-slate-400">Block</dt>
              <dd className="text-white font-medium mt-1">{selectedTx.blockNumber ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => copyTxHash(selectedTx.txHash)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white"
            >
              <Copy size={14} />
              Copy hash
            </button>
            <Link
              to="/trading"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 text-sm text-slate-300 hover:bg-slate-700/50"
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
