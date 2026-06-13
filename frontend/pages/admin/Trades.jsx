import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  AlertCircle,
  ArrowRightLeft,
  ExternalLink,
  Copy,
  Check,
  ArrowRight,
} from 'lucide-react';
import SectionTitle from '../../components/ui/SectionTitle';
import EmptyState from '../../components/ui/EmptyState';
import PageLoader from '../../components/ui/PageLoader';
import Pagination from '../../components/admin/Pagination';
import RetryCard from '../../components/admin/RetryCard';
import { StatusPill, shortWallet, formatDateTime } from '../../utils/adminFormat';
import { explorerTxUrl, explorerAddressUrl } from '../../utils/adminFormat';
import { useToast } from '../../context/ToastContext';
import { adminApi } from '../../utils/api';

const LIMIT = 25;
const EVENT_OPTIONS = [
  ['listed', 'Listed'],
  ['purchased', 'Purchased'],
  ['cancelled', 'Cancelled'],
];

const WalletCell = ({ address, chainId, copied, onCopy }) => {
  if (!address) return <span className="text-slate-600 text-xs">—</span>;
  const explorer = explorerAddressUrl(chainId, address);
  return (
    <div className="flex items-center gap-1">
      {explorer ? (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-blue-400 hover:text-blue-300 transition-colors"
          title={address}
        >
          {shortWallet(address)}
        </a>
      ) : (
        <span className="font-mono text-xs text-slate-400" title={address}>{shortWallet(address)}</span>
      )}
      <button
        type="button"
        onClick={() => onCopy(address, address)}
        className="text-slate-500 hover:text-slate-300 transition-colors"
        title="Copy address"
      >
        {copied === address ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      </button>
    </div>
  );
};

const Trades = () => {
  const toast = useToast();

  const [data, setData] = useState({ trades: [], meta: { page: 1, limit: LIMIT, total: 0, pages: 1 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [page, setPage] = useState(1);
  const [eventFilter, setEventFilter] = useState('');
  const [walletInput, setWalletInput] = useState('');
  const [wallet, setWallet] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState('');

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      setWallet(walletInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [walletInput]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const params = { page, limit: LIMIT };
        if (eventFilter) params.eventType = eventFilter;
        if (wallet) params.wallet = wallet;
        const res = await adminApi.listTrades(params);
        if (!active) return;
        const pages = res.meta?.pages || 1;
        setData({
          trades: res.data || [],
          meta: res.meta || { page, limit: LIMIT, total: 0, pages: 1 },
        });
        if (page > pages) setPage(Math.max(1, pages));
      } catch (err) {
        if (!active) return;
        setError(err.message || 'Failed to load trades');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, eventFilter, wallet, reloadKey]);

  const copyText = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      toast.success('Copied');
      setTimeout(() => setCopied(''), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  const hasFilters = eventFilter || wallet;
  const clearFilters = () => {
    setEventFilter('');
    setWalletInput('');
    setPage(1);
  };
  const selectClass =
    'px-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40';
  const meta = data.meta || {};

  return (
    <div className="page-section w-full">
      <SectionTitle
        title="Trades"
        subtitle="On-chain energy trade history"
        action={
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-400 text-xs font-medium">
            <ArrowRightLeft size={14} />
            {meta.total ?? 0} total
          </span>
        }
      />

      <div className="content-card mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              aria-label="Filter by wallet address"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              placeholder="Filter by wallet address (seller or buyer)…"
              className="w-full pl-9 pr-3 py-2.5 bg-slate-950 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 font-mono"
            />
          </div>
          <select aria-label="Filter by event type" value={eventFilter} onChange={(e) => { setEventFilter(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">All events</option>
            {EVENT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="px-3 py-2.5 text-sm font-medium text-slate-400 hover:text-white border border-slate-700/60 rounded-lg hover:bg-slate-800 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && data.trades.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertCircle size={16} className="flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader message="Loading trades…" />
      ) : data.trades.length === 0 && error ? (
        <RetryCard message={error} onRetry={refresh} />
      ) : data.trades.length === 0 ? (
        <div className="content-card">
          <EmptyState
            illustration="trading"
            title={hasFilters ? 'No matching trades' : 'No trades yet'}
            description={hasFilters ? 'Try adjusting your filters.' : 'Indexed blockchain trades will appear here.'}
          />
        </div>
      ) : (
        <div className="content-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-3 font-semibold">Event</th>
                  <th className="px-4 py-3 font-semibold">Listing</th>
                  <th className="px-4 py-3 font-semibold">Seller</th>
                  <th className="px-4 py-3 font-semibold">Buyer</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Amount / Price</th>
                  <th className="px-4 py-3 font-semibold">Tx Hash</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Time</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t) => {
                  const txUrl = explorerTxUrl(t.chainId, t.txHash);
                  return (
                    <tr key={`${t.txHash}-${t.logIndex}`} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3"><StatusPill value={t.eventType} /></td>
                      <td className="px-4 py-3 text-slate-300 font-mono text-xs">#{t.listingId}</td>
                      <td className="px-4 py-3"><WalletCell address={t.seller} chainId={t.chainId} copied={copied} onCopy={copyText} /></td>
                      <td className="px-4 py-3">
                        {t.buyer ? (
                          <div className="flex items-center gap-1.5">
                            <ArrowRight size={11} className="text-slate-600" />
                            <WalletCell address={t.buyer} chainId={t.chainId} copied={copied} onCopy={copyText} />
                          </div>
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <p className="text-slate-200 text-xs font-medium">{Number(t.energyAmount || 0).toLocaleString()} kWh</p>
                        <p className="text-slate-500 text-xs">{Number(t.price || 0).toLocaleString()} ETH</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {txUrl ? (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              title={t.txHash}
                            >
                              {shortWallet(t.txHash)}
                              <ExternalLink size={11} />
                            </a>
                          ) : (
                            <span className="font-mono text-xs text-slate-400" title={t.txHash}>{shortWallet(t.txHash)}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => copyText(t.txHash, t.txHash)}
                            className="text-slate-500 hover:text-slate-300 transition-colors"
                            title="Copy tx hash"
                          >
                            {copied === t.txHash ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-slate-400 text-xs" title={t.blockTimestamp || undefined}>
                        {formatDateTime(t.blockTimestamp)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} loading={loading} onChange={setPage} />
        </div>
      )}
    </div>
  );
};

export default Trades;
