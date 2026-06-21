const BlockchainService = require('../blockchainService');
const {
  getTradeStats,
  getPlatformVolumeByDay,
  getUniqueTraderCount,
  getWalletFlowHistory,
  parsePrice,
} = require('./tradeAnalytics');

const getOnChainWalletBalances = async (walletAddress) => {
  try {
    const [balance, allowance] = await Promise.all([
      BlockchainService.getBalance(walletAddress),
      BlockchainService.getAllowance(walletAddress),
    ]);
    return { balance, allowance };
  } catch {
    return { balance: null, allowance: null };
  }
};

const getCarbonBalanceAnalytics = async (walletAddress, days = 30, tradeStatsOverride = null) => {
  const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  const tradeStatsPromise = tradeStatsOverride
    ? Promise.resolve(tradeStatsOverride)
    : getTradeStats();

  const [platformVolumeByDay, tradeStats, uniqueTraders, walletFlows] = await Promise.all([
    getPlatformVolumeByDay(since),
    tradeStatsPromise,
    getUniqueTraderCount(),
    walletAddress ? getWalletFlowHistory(walletAddress, since) : null,
  ]);

  let wallet = null;
  if (walletAddress) {
    const onChain = await getOnChainWalletBalances(walletAddress);
    const balanceNum = parsePrice(onChain.balance);
    const allowanceNum = parsePrice(onChain.allowance);

    wallet = {
      address: walletAddress,
      balance: onChain.balance,
      allowance: onChain.allowance,
      unapprovedBalance: Math.max(0, balanceNum - allowanceNum),
      creditsReceived: walletFlows?.creditsReceived || 0,
      creditsSpent: walletFlows?.creditsSpent || 0,
      netFlow: walletFlows?.netFlow || 0,
      saleCount: walletFlows?.saleCount || 0,
      purchaseCount: walletFlows?.purchaseCount || 0,
      history: walletFlows?.history || [],
    };
  }

  let totalSupply = null;
  try {
    totalSupply = await BlockchainService.getTotalSupply();
  } catch {
    totalSupply = null;
  }

  return {
    periodDays: days,
    wallet,
    platform: {
      totalCreditsTraded: tradeStats.totalVolumeCredits,
      completedTrades: tradeStats.completedTrades,
      totalSupply,
      uniqueTraders,
      volumeByDay: platformVolumeByDay,
    },
  };
};

const getCarbonStats = async (walletAddress) => {
  const tradeStats = await getTradeStats();
  const balanceAnalytics = await getCarbonBalanceAnalytics(walletAddress, 30, tradeStats);

  let walletBalance = balanceAnalytics.wallet?.balance ?? null;
  if (!walletBalance && walletAddress) {
    const onChain = await getOnChainWalletBalances(walletAddress);
    walletBalance = onChain.balance;
  }

  return {
    totalCreditsTraded: tradeStats.totalVolumeCredits,
    completedTrades: tradeStats.completedTrades,
    walletBalance,
    estimatedGridCredits: Math.round(
      tradeStats.totalVolumeCredits + tradeStats.totalEnergyTraded * 0.1,
    ),
    balanceAnalytics,
  };
};

module.exports = {
  getCarbonStats,
  getCarbonBalanceAnalytics,
  getOnChainWalletBalances,
};
