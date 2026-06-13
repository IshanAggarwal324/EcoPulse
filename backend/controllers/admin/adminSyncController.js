const blockchainSyncService = require('../../services/blockchainSyncService');
const socketBroadcastService = require('../../services/socketBroadcastService');
const asyncHandler = require('../../utils/asyncHandler');

const getSyncStatus = asyncHandler(async (req, res) => {
  const status = await blockchainSyncService.getChainStatus();

  res.status(200).json({
    success: true,
    data: status,
  });
});

const forceSync = asyncHandler(async (req, res) => {
  const result = await blockchainSyncService.syncBlockchainTrades();

  await socketBroadcastService.flushAnalytics('full');

  res.status(200).json({
    success: true,
    data: result,
  });
});

module.exports = {
  getSyncStatus,
  forceSync,
};
