import React from 'react';
import { Zap, Clock, Tag } from 'lucide-react';
import ReputationBadge from './ReputationBadge';

const formatAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString();
};

const MarketplaceOrderCard = ({
  order,
  account,
  loading,
  isCorrectNetwork,
  onPurchase,
  onPurchaseEscrow,
  onCancel,
}) => {
  const isOwner =
    account && order.seller?.toLowerCase() === account.toLowerCase();

  return (
    <article className="glass-card p-4 rounded-xl card-hover-glow">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2.5">
            <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded-lg font-medium border border-emerald-500/20">
              Order #{order.listingId}
            </span>
            <span className="text-xs px-2 py-1 bg-slate-700/30 text-slate-500 rounded-lg border border-slate-700/20">
              Active
            </span>
            <ReputationBadge reputation={order.reputation} />
          </div>

          <div className="flex items-center gap-2 text-white font-semibold text-lg mb-1.5">
            <Zap size={18} className="text-yellow-400 shrink-0" />
            {order.energyAmount} energy units
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
            <span className="font-mono text-xs">Seller {formatAddress(order.seller)}</span>
            {order.unitPrice > 0 && (
              <span className="flex items-center gap-1 text-xs">
                <Tag size={12} />
                {order.unitPrice.toFixed(4)} CC / unit
              </span>
            )}
            {order.createdAt && (
              <span className="flex items-center gap-1 text-xs">
                <Clock size={12} />
                {formatDate(order.createdAt)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end shrink-0">
          <div className="text-right">
            <p className="text-[10px] text-slate-600 uppercase tracking-wider mb-0.5">Total price</p>
            <p className="text-emerald-400 font-bold text-xl font-mono">{order.price} CC</p>
          </div>

          {isOwner ? (
            <button
              type="button"
              onClick={() => onCancel(order.listingId)}
              disabled={loading || !isCorrectNetwork}
              className="touch-target bg-amber-600/80 hover:bg-amber-500/80 disabled:bg-slate-700/50 text-white px-4 py-2.5 rounded-xl font-medium transition-all duration-200 w-full sm:w-auto"
            >
              Cancel order
            </button>
          ) : (
            <div className="flex flex-col gap-2 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => onPurchase(order.listingId, order.price)}
                disabled={loading || !isCorrectNetwork || !account}
                className="touch-target bg-blue-600/80 hover:bg-blue-500/80 disabled:bg-slate-700/50 text-white px-4 py-2.5 rounded-xl font-medium transition-all duration-200 w-full sm:w-auto"
              >
                Buy now
              </button>
              {onPurchaseEscrow && (
                <button
                  type="button"
                  onClick={() => onPurchaseEscrow(order)}
                  disabled={loading || !isCorrectNetwork || !account}
                  title="Lock funds in escrow — release after delivery, or dispute"
                  className="touch-target bg-slate-700/60 hover:bg-slate-600/60 disabled:bg-slate-700/40 text-emerald-300 border border-emerald-500/20 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 w-full sm:w-auto"
                >
                  Buy via escrow
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
};

export default MarketplaceOrderCard;
