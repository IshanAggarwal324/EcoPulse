/**
 * Admin marketplace emergency-stop controller (Sub-module 2.4 guardrail).
 *
 * Wires the contract-level `pause()` / `unpause()` to an admin emergency stop.
 * Pause is a hard kill switch: while paused no listings, purchases, or
 * cancellations can land on-chain. This complements (but is independent of) the
 * auto-trading matcher pause — the contract pause also blocks manual trades.
 *
 * Every state change is audit-logged at 'critical' severity so a marketplace
 * halt is always attributable.
 */

const BlockchainService = require('../../services/blockchainService');
const auditService = require('../../services/auditService');
const asyncHandler = require('../../utils/asyncHandler');

const requireContract = () => {
  if (!process.env.ENERGY_TRADING_ADDRESS) {
    const err = new Error('ENERGY_TRADING_ADDRESS not configured');
    err.statusCode = 503;
    err.code = 'CONTRACT_NOT_CONFIGURED';
    throw err;
  }
};

const getStatus = asyncHandler(async (req, res) => {
  requireContract();
  let paused = false;
  try {
    paused = await BlockchainService.isMarketplacePaused();
  } catch (err) {
    return res.status(503).json({
      success: false,
      message: 'Unable to read marketplace pause state from the chain.',
      code: 'CHAIN_UNAVAILABLE',
      error: err.message,
    });
  }
  res.status(200).json({ success: true, data: { paused } });
});

const pause = asyncHandler(async (req, res) => {
  requireContract();
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 255) : null;
  const txHash = await BlockchainService.pauseMarketplace();

  await auditService.log({
    actor: req.user,
    action: 'MARKETPLACE_PAUSED',
    resourceType: 'trade',
    resourceId: txHash,
    metadata: { reason, txHash },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'Marketplace paused. All on-chain listing/purchase writes are blocked.',
    data: { paused: true, txHash },
  });
});

const resume = asyncHandler(async (req, res) => {
  requireContract();
  const txHash = await BlockchainService.unpauseMarketplace();

  await auditService.log({
    actor: req.user,
    action: 'MARKETPLACE_RESUMED',
    resourceType: 'trade',
    resourceId: txHash,
    metadata: { txHash },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'Marketplace resumed.',
    data: { paused: false, txHash },
  });
});

module.exports = { getStatus, pause, resume };
