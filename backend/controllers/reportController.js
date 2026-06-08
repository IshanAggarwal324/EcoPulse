const reportService = require('../services/reportService');
const asyncHandler = require('../utils/asyncHandler');

const getReportPreview = asyncHandler(async (req, res) => {
  const period = req.query.period || '7d';
  const scope = req.query.scope || 'both';
  const walletAddress = req.query.wallet || req.user?.walletAddress || null;

  const metrics = await reportService.buildReportMetrics({ period, walletAddress, scope });

  res.status(200).json({
    success: true,
    data: metrics,
  });
});

module.exports = { getReportPreview };
