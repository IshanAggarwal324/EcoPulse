const reportService = require('../services/reportService');
const asyncHandler = require('../utils/asyncHandler');

const VALID_PERIODS = ['7d', '14d', '30d'];
const VALID_SCOPES = ['personal', 'grid', 'both'];
const VALID_DELIVERIES = ['chat', 'email'];

function validateReportRequest({ period, scope, delivery }) {
  const errors = [];

  if (!period || !VALID_PERIODS.includes(period)) {
    errors.push(`Invalid period "${period}". Must be one of: ${VALID_PERIODS.join(', ')}`);
  }

  if (!scope || !VALID_SCOPES.includes(scope)) {
    errors.push(`Invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`);
  }

  if (!delivery || !VALID_DELIVERIES.includes(delivery)) {
    errors.push(`Invalid delivery "${delivery}". Must be one of: ${VALID_DELIVERIES.join(', ')}`);
  }

  if (delivery === 'email') {
    return {
      valid: false,
      status: 501,
      message: 'Email delivery is not yet available. Use "chat" delivery for now.',
    };
  }

  if (errors.length > 0) {
    return { valid: false, status: 400, message: errors.join(' ') };
  }

  return { valid: true };
}

const SECTION_SOURCES = {
  gridEnergy: { type: 'analytics', label: 'Grid energy totals', endpoint: '/analytics/energy' },
  gridTrading: { type: 'analytics', label: 'Grid trading stats', endpoint: '/analytics/trades' },
  nodeOverview: { type: 'analytics', label: 'Node overview', endpoint: '/analytics/nodes' },
  personalProfit: { type: 'analytics', label: 'Wallet profit', endpoint: '/analytics/wallet' },
  carbon: { type: 'analytics', label: 'Carbon credits', endpoint: '/analytics/carbon' },
};

function buildSourcesFromMetrics(metrics) {
  const sources = [];
  for (const [key, source] of Object.entries(SECTION_SOURCES)) {
    if (metrics[key] != null) {
      sources.push(source);
    }
  }
  return sources;
}

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

module.exports = { validateReportRequest, buildSourcesFromMetrics, getReportPreview };
