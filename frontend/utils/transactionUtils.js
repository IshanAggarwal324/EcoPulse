export const EVENT_LABELS = {
  listed: 'Listed',
  purchased: 'Purchased',
  cancelled: 'Cancelled',
};

export const DIRECTION_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'received', label: 'Received' },
  { id: 'sent', label: 'Sent' },
  { id: 'marketplace', label: 'Listings' },
  { id: 'listed', label: 'Listed', eventType: 'listed' },
  { id: 'purchased', label: 'Purchased', eventType: 'purchased' },
  { id: 'cancelled', label: 'Cancelled', eventType: 'cancelled' },
];

export const PERIOD_FILTERS = [
  { days: '', label: 'All time' },
  { days: '7', label: '7 days' },
  { days: '30', label: '30 days' },
  { days: '90', label: '90 days' },
];

const CLIENT_ONLY_FILTERS = new Set(['received', 'sent', 'marketplace']);

export const isClientOnlyFilter = (filterId) => CLIENT_ONLY_FILTERS.has(filterId);

export const parseAmount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

export const classifyTrade = (trade, wallet) => {
  if (!wallet) {
    return {
      direction: 'neutral',
      label: EVENT_LABELS[trade.eventType] || trade.eventType,
      amount: parseAmount(trade.price),
    };
  }

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

  return {
    direction: 'marketplace',
    label: EVENT_LABELS[trade.eventType] || 'Marketplace',
    amount: parseAmount(trade.price),
  };
};

export const applyDirectionFilter = (trades, filterId, wallet) => {
  if (filterId === 'all') return trades;
  if (isClientOnlyFilter(filterId)) {
    if (!wallet) return trades;
    return trades.filter((t) => classifyTrade(t, wallet).direction === filterId);
  }
  return trades;
};

export const buildHistoryParams = ({
  wallet,
  filterId,
  periodDays,
  listingId,
  minPrice,
  maxPrice,
  limit = 100,
  page = 1,
}) => {
  const params = { limit, page };

  if (wallet) params.wallet = wallet;
  if (periodDays) params.sinceDays = periodDays;
  if (listingId?.trim()) params.listingId = listingId.trim();
  if (minPrice !== '' && minPrice != null) params.minPrice = minPrice;
  if (maxPrice !== '' && maxPrice != null) params.maxPrice = maxPrice;

  const filterDef = DIRECTION_FILTERS.find((f) => f.id === filterId);
  if (filterDef?.eventType) {
    params.eventType = filterDef.eventType;
  }

  return params;
};

export const summarizeFromTrades = (trades, wallet) => {
  const summary = {
    total: trades.length,
    listed: 0,
    purchased: 0,
    cancelled: 0,
    totalVolumeCc: 0,
    totalEnergyTraded: 0,
    creditsReceived: 0,
    creditsSpent: 0,
    netFlow: 0,
  };

  trades.forEach((trade) => {
    if (trade.eventType === 'listed') summary.listed += 1;
    if (trade.eventType === 'purchased') {
      summary.purchased += 1;
      summary.totalVolumeCc += parseAmount(trade.price);
      summary.totalEnergyTraded += parseAmount(trade.energyAmount);
    }
    if (trade.eventType === 'cancelled') summary.cancelled += 1;

    if (wallet) {
      const info = classifyTrade(trade, wallet);
      if (info.direction === 'received') summary.creditsReceived += info.amount;
      if (info.direction === 'sent') summary.creditsSpent += info.amount;
    }
  });

  summary.netFlow = summary.creditsReceived - summary.creditsSpent;
  return summary;
};

export const getDisplaySummary = (filteredTrades, wallet, apiSummary, filterId) => {
  const showing = filteredTrades.length;
  const matchTotal = apiSummary?.total ?? showing;

  if (isClientOnlyFilter(filterId) || !apiSummary) {
    return { ...summarizeFromTrades(filteredTrades, wallet), showing, matchTotal };
  }

  return {
    ...apiSummary,
    showing,
    matchTotal,
  };
};
