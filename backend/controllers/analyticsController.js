const analyticsService = require('../services/analyticsService');
const blockchainSyncService = require('../services/blockchainSyncService');
const socketBroadcastService = require('../services/socketBroadcastService');
const asyncHandler = require('../utils/asyncHandler');

const getSummary = asyncHandler(async (req, res) => {
  const walletAddress = req.query.wallet || null;
  const sinceHours = req.query.sinceHours ? parseInt(req.query.sinceHours, 10) : null;

  const summary = await analyticsService.getSummary({ walletAddress, sinceHours });

  res.status(200).json({
    success: true,
    data: summary,
  });
});

const getEnergyAnalytics = asyncHandler(async (req, res) => {
  const sinceHours = req.query.sinceHours ? parseInt(req.query.sinceHours, 10) : null;
  const since = sinceHours
    ? new Date(Date.now() - sinceHours * 60 * 60 * 1000)
    : null;

  const energy = await analyticsService.getEnergyTotals(since);

  res.status(200).json({
    success: true,
    data: energy,
  });
});

const getNodeAnalytics = asyncHandler(async (req, res) => {
  const nodes = await analyticsService.getNodeStats();

  res.status(200).json({
    success: true,
    data: nodes,
  });
});

const getTradeAnalytics = asyncHandler(async (req, res) => {
  const trades = await analyticsService.getTradeStats();

  res.status(200).json({
    success: true,
    data: trades,
  });
});

const getCarbonAnalytics = asyncHandler(async (req, res) => {
  const walletAddress = req.query.wallet || null;
  const carbon = await analyticsService.getCarbonStats(walletAddress);

  res.status(200).json({
    success: true,
    data: carbon,
  });
});

const getCarbonBalanceAnalytics = asyncHandler(async (req, res) => {
  const walletAddress = req.query.wallet || null;
  const days = req.query.days ? parseInt(req.query.days, 10) : 30;

  const analytics = await analyticsService.getCarbonBalanceAnalytics(walletAddress, days);

  res.status(200).json({
    success: true,
    data: analytics,
  });
});

const syncBlockchain = asyncHandler(async (req, res) => {
  const result = await blockchainSyncService.syncBlockchainTrades();
  const summary = await analyticsService.getSummary();

  await socketBroadcastService.flushAnalytics('full');

  res.status(200).json({
    success: true,
    data: { sync: result, summary },
  });
});

const getPlatformStatus = asyncHandler(async (req, res) => {
  const [chain, readingCount] = await Promise.all([
    blockchainSyncService.getChainStatus(),
    require('../models/EnergyReading').countDocuments(),
  ]);

  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
  let aiStatus = { connected: false };

  try {
    const response = await fetch(`${aiServiceUrl}/`);
    aiStatus = {
      connected: response.ok,
      status: response.ok ? 'online' : 'degraded',
    };
  } catch (error) {
    aiStatus = { connected: false, status: 'offline', error: error.message };
  }

  res.status(200).json({
    success: true,
    data: {
      mongodb: { connected: true, readingCount },
      blockchain: chain,
      ai: aiStatus,
      syncedAt: new Date().toISOString(),
    },
  });
});

module.exports = {
  getSummary,
  getEnergyAnalytics,
  getNodeAnalytics,
  getTradeAnalytics,
  getCarbonAnalytics,
  getCarbonBalanceAnalytics,
  syncBlockchain,
  getPlatformStatus,
};
