const analyticsService = require('../services/analyticsService');
const blockchainSyncService = require('../services/blockchainSyncService');
const socketBroadcastService = require('../services/socketBroadcastService');
const healthService = require('../services/healthService');
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
  const EnergyReading = require('../models/EnergyReading');

  const [health, readingCount] = await Promise.all([
    healthService.getHealth(),
    EnergyReading.estimatedDocumentCount().catch(() => 0),
  ]);

  const c = health.components;
  const blockchain = c.blockchain.details || {};

  res.status(200).json({
    success: true,
    data: {
      overall: health.overall,
      mongodb: { connected: c.mongodb.status === 'up', readingCount },
      blockchain: {
        connected: c.blockchain.status !== 'down',
        chainName: blockchain.chainName || null,
        chainId: blockchain.chainId ?? null,
        blockNumber: blockchain.blockNumber ?? null,
        lastSyncedBlock: blockchain.lastSyncedBlock ?? null,
        syncLagBlocks: blockchain.syncLagBlocks ?? null,
        isSyncHealthy: blockchain.isSyncHealthy ?? false,
      },
      ai: {
        connected: c.aiService.status !== 'down',
        status: c.aiService.status,
      },
      genai: {
        connected: c.genaiService.status !== 'down',
        status: c.genaiService.status,
      },
      syncedAt: health.checkedAt,
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
