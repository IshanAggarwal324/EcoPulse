import React from 'react';
import { Zap, Clock, Tag } from 'lucide-react';

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
  onCancel,
}) => {
  const isOwner =
    account && order.seller?.toLowerCase() === account.toLowerCase();

  return (
    <article className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50 hover:border-slate-600/80 transition-colors">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-400 rounded-md font-medium">
              Order #{order.listingId}
            </span>
            <span className="text-xs px-2 py-1 bg-slate-700/50 text-slate-300 rounded-md">
              Active
            </span>
          </div>

          <div className="flex items-center gap-2 text-white font-semibold text-lg mb-1">
            <Zap size={18} className="text-yellow-400 shrink-0" />
            {order.energyAmount} energy units
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
            <span className="font-mono">Seller {formatAddress(order.seller)}</span>
            {order.unitPrice > 0 && (
              <span className="flex items-center gap-1">
                <Tag size={14} />
                {order.unitPrice.toFixed(4)} CC / unit
              </span>
            )}
            {order.createdAt && (
              <span className="flex items-center gap-1">
                <Clock size={14} />
                {formatDate(order.createdAt)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end shrink-0">
          <div className="text-right">
            <p className="text-xs text-slate-500 uppercase tracking-wider">Total price</p>
            <p className="text-emerald-400 font-bold text-xl">{order.price} CC</p>
          </div>

          {isOwner ? (
            <button
              type="button"
              onClick={() => onCancel(order.listingId)}
              disabled={loading || !isCorrectNetwork}
              className="touch-target bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white px-4 py-3 rounded-lg font-medium transition-colors w-full sm:w-auto"
            >
              Cancel order
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPurchase(order.listingId, order.price)}
              disabled={loading || !isCorrectNetwork || !account}
              className="touch-target bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white px-4 py-3 rounded-lg font-medium transition-colors w-full sm:w-auto"
            >
              Buy now
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

export default MarketplaceOrderCard;
