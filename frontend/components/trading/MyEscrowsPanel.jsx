import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { escrowApi } from '../../utils/api';
import {
  confirmDelivery,
  releaseEscrow,
  openDispute,
  claimTimeoutRefund,
  getEscrowDisputeWindow,
} from '../../utils/blockchain';
import { useWallet } from '../../context/WalletContext';
import { useToast } from '../../context/ToastContext';
import { useSocketEvent } from '../../context/SocketContext';
import { SOCKET_EVENTS } from '../../constants/socketEvents';

const STATE_STYLES = {
  funded: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  delivered: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  disputed: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  released: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  refunded: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
};

const STATE_LABELS = {
  funded: 'Funds locked',
  delivered: 'Delivery confirmed',
  disputed: 'In dispute',
  released: 'Released to seller',
  refunded: 'Refunded to buyer',
};

const formatDateTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

const shortAddress = (address) => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '—');

const friendlyError = (error) => {
  if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) return 'Transaction cancelled in your wallet.';
  return error?.shortMessage || error?.reason || error?.message || 'Transaction failed';
};

/** Role of the connected wallet in an escrow row. */
export const roleOf = (escrow, account) => {
  const wallet = String(account || '').toLowerCase();
  if (!wallet) return null;
  if (escrow.buyer === wallet) return 'buyer';
  if (escrow.seller === wallet) return 'seller';
  return null;
};

/** Plain-language "what now?" line for an escrow row. */
export const describeNextStep = (escrow, role, windowEndsAt, now = Date.now()) => {
  const until = windowEndsAt ? formatDateTime(windowEndsAt) : null;
  const windowOpen = windowEndsAt ? now <= windowEndsAt : null;
  switch (escrow.state) {
    case 'funded':
      return role === 'seller'
        ? "The buyer's funds are locked. Confirm delivery once the energy is delivered."
        : `Your funds are locked. Release them when you have received the energy${
            windowOpen && until ? `, or open a dispute before ${until}` : ''
          }.`;
    case 'delivered':
      return role === 'seller'
        ? 'Delivery confirmed. Waiting for the buyer to release the funds.'
        : `The seller confirmed delivery. Release the funds${
            windowOpen && until ? `, or open a dispute before ${until}` : ''
          }.`;
    case 'disputed':
      return 'A dispute is open. An arbiter will rule: release, refund or split the funds.';
    case 'released':
      return 'Settled: the funds were paid to the seller.';
    case 'refunded':
      return 'Settled: the funds were returned to the buyer.';
    default:
      return '';
  }
};

const MyEscrowsPanel = ({ refreshKey = 0, activeListingIds = [], onChanged, onCloseListing }) => {
  const { account } = useWallet();
  const toast = useToast();
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [windowSec, setWindowSec] = useState(null);
  const [disputeFor, setDisputeFor] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!account) {
      setEscrows([]);
      return;
    }
    setLoading(true);
    try {
      const response = await escrowApi.list({ limit: 50 });
      setEscrows(Array.isArray(response?.data) ? response.data : []);
    } catch {
      // Keep the previous list; the next refresh will retry.
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    getEscrowDisputeWindow().then((seconds) => {
      if (!cancelled) setWindowSec(seconds);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useSocketEvent(SOCKET_EVENTS.SERVER.BLOCKCHAIN_EVENT, (data) => {
    if (data?.eventType === 'escrow_event') load();
  });

  const run = async (escrow, label, action) => {
    if (!account) {
      toast.info('Connect your wallet to continue');
      return;
    }
    setBusyId(escrow.escrowId);
    try {
      toast.info(`Confirm "${label}" in your wallet...`);
      const receipt = await action();
      toast.success(`${label}: confirmed on-chain.`);
      if (receipt?.hash) {
        // Index right away so this panel and the order book update without waiting.
        await escrowApi.indexTx(receipt.hash).catch(() => {});
      }
      setDisputeFor(null);
      setReason('');
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(friendlyError(error));
    } finally {
      setBusyId(null);
    }
  };

  const submitDispute = (escrow) => {
    const evidence = reason.trim();
    if (!evidence) {
      toast.info('Describe the problem so the arbiter can review it.');
      return;
    }
    run(escrow, 'Open dispute', () => openDispute(escrow.escrowId, evidence));
  };

  if (!account) return null;

  const mine = escrows.filter((escrow) => roleOf(escrow, account));

  return (
    <section className="content-card" aria-label="My escrows">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4">
        <div>
          <h3 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={20} className="text-emerald-400" />
            My escrows
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Purchases where the funds are held until delivery. Manage each step here.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="touch-target inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 text-sm font-medium py-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {mine.length === 0 ? (
        <p className="text-sm text-slate-500 py-4">
          {loading ? 'Loading escrows...' : 'No escrows yet. Use "Buy via escrow" on an order to start one.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {mine.map((escrow) => {
            const role = roleOf(escrow, account);
            const createdMs = escrow.createdAt ? new Date(escrow.createdAt).getTime() : null;
            const windowEndsAt = createdMs && windowSec ? createdMs + windowSec * 1000 : null;
            const windowOpen = windowEndsAt ? Date.now() <= windowEndsAt : null;
            const open = escrow.state === 'funded' || escrow.state === 'delivered';
            const busy = busyId === escrow.escrowId;
            const counterparty = role === 'buyer' ? escrow.seller : escrow.buyer;
            const canCloseListing =
              role === 'seller' &&
              escrow.state === 'released' &&
              escrow.listingId !== null &&
              escrow.listingId !== undefined &&
              activeListingIds.includes(Number(escrow.listingId));

            return (
              <li
                key={`${escrow.contractAddress}-${escrow.escrowId}`}
                className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-1 rounded-lg font-medium border bg-slate-700/30 text-slate-300 border-slate-600/40">
                    Escrow #{escrow.escrowId}
                  </span>
                  {escrow.listingId !== null && escrow.listingId !== undefined && (
                    <span className="text-xs px-2 py-1 rounded-lg border bg-emerald-500/10 text-emerald-300 border-emerald-500/20">
                      Order #{escrow.listingId}
                    </span>
                  )}
                  <span
                    className={`text-xs px-2 py-1 rounded-lg font-medium border ${
                      STATE_STYLES[escrow.state] || STATE_STYLES.funded
                    }`}
                  >
                    {STATE_LABELS[escrow.state] || escrow.state}
                  </span>
                  <span className="text-xs px-2 py-1 rounded-lg border bg-slate-700/30 text-slate-400 border-slate-600/40">
                    You are the {role}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-400 mb-2">
                  <span className="text-emerald-400 font-bold font-mono">
                    {escrow.amountEther ?? '—'} CC
                  </span>
                  <span className="font-mono text-xs">
                    {role === 'buyer' ? 'Seller' : 'Buyer'} {shortAddress(counterparty)}
                  </span>
                  <span className="text-xs">Opened {formatDateTime(createdMs)}</span>
                  {open && windowEndsAt && (
                    <span className="text-xs">
                      Dispute window {windowOpen ? 'closes' : 'closed'} {formatDateTime(windowEndsAt)}
                    </span>
                  )}
                </div>

                <p className="text-sm text-slate-300">{describeNextStep(escrow, role, windowEndsAt)}</p>

                <div className="flex flex-wrap gap-2 mt-3">
                  {role === 'seller' && escrow.state === 'funded' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(escrow, 'Confirm delivery', () => confirmDelivery(escrow.escrowId))}
                      className="touch-target bg-emerald-600/80 hover:bg-emerald-500/80 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                    >
                      Confirm delivery
                    </button>
                  )}

                  {role === 'buyer' && open && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(escrow, 'Release funds', () => releaseEscrow(escrow.escrowId))}
                      className="touch-target bg-blue-600/80 hover:bg-blue-500/80 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                    >
                      Release funds to seller
                    </button>
                  )}

                  {role === 'buyer' && open && windowOpen !== false && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDisputeFor(disputeFor === escrow.escrowId ? null : escrow.escrowId);
                        setReason('');
                      }}
                      className="touch-target bg-amber-600/70 hover:bg-amber-500/70 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                    >
                      Open dispute
                    </button>
                  )}

                  {role === 'buyer' && open && windowOpen === false && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(escrow, 'Claim refund', () => claimTimeoutRefund(escrow.escrowId))}
                      className="touch-target bg-slate-600/70 hover:bg-slate-500/70 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                    >
                      Claim refund
                    </button>
                  )}

                  {canCloseListing && onCloseListing && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onCloseListing(Number(escrow.listingId))}
                      className="touch-target bg-slate-600/70 hover:bg-slate-500/70 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                      title="This order was paid through escrow; close it so nobody else can buy it"
                    >
                      Close listing #{escrow.listingId}
                    </button>
                  )}

                  {busy && <Loader2 size={18} className="animate-spin text-emerald-400 self-center" />}
                </div>

                {disputeFor === escrow.escrowId && (
                  <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                    <label htmlFor={`dispute-${escrow.escrowId}`} className="block text-xs text-slate-400 mb-1">
                      What went wrong? (a fingerprint of this text is stored on-chain as your evidence)
                    </label>
                    <textarea
                      id={`dispute-${escrow.escrowId}`}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={3}
                      maxLength={500}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-amber-500"
                      placeholder="e.g. The energy was never delivered."
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => submitDispute(escrow)}
                        className="touch-target bg-amber-600/80 hover:bg-amber-500/80 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium"
                      >
                        Submit dispute
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisputeFor(null)}
                        className="touch-target text-slate-400 hover:text-slate-200 px-3 py-2 text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default MyEscrowsPanel;
