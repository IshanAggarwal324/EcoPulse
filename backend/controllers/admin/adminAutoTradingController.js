/**
 * Admin auto-trading controller (Sub-module 2.3 — kill switch / observability).
 *
 * Surfaces the runtime kill switch (pause/resume, layered on the env flag) and
 * matcher status. All endpoints are admin-only (enforced in routes). Pause is a
 * redeploy-free stop: the matcher's per-tick gate re-reads the DB doc, so a
 * pause takes effect on the next tick without a restart.
 */

const AutoTradingConfig = require('../../models/AutoTradingConfig');
const AutoListingPolicy = require('../../models/AutoListingPolicy');
const autoTradingService = require('../../services/pricing/autoTradingService');
const autoListingMatcher = require('../../workers/autoListingMatcher');
const autoTradingAnalytics = require('../../services/analytics/autoTradingAnalytics');
const autoConfig = require('../../config/autoTrading');
const auditService = require('../../services/auditService');
const asyncHandler = require('../../utils/asyncHandler');

const getStatus = asyncHandler(async (req, res) => {
  const [workerStatus, policyCounts] = await Promise.all([
    autoListingMatcher.getStatus(),
    Promise.all([
      AutoListingPolicy.countDocuments({ enabled: true }),
      AutoListingPolicy.countDocuments({}),
    ]).then(([enabled, total]) => ({ enabled, total })),
  ]);

  res.status(200).json({
    success: true,
    data: {
      ...workerStatus,
      policies: policyCounts,
    },
  });
});

const pause = asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 255) : null;
  const cfg = await AutoTradingConfig.findOneAndUpdate(
    { key: 'global' },
    {
      $set: {
        paused: true,
        pausedAt: new Date(),
        pausedBy: req.user?._id || null,
        pausedReason: reason,
        updatedBy: req.user?._id || null,
      },
    },
    { upsert: true, new: true },
  ).lean();

  await auditService.log({
    actor: req.user,
    action: 'AUTO_TRADING_PAUSED',
    resourceType: 'auto_trading',
    resourceId: 'global',
    metadata: { reason },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'Auto-trading paused. The matcher will stop evaluating policies on the next tick.',
    data: { paused: cfg.paused, pausedAt: cfg.pausedAt },
  });
});

const resume = asyncHandler(async (req, res) => {
  if (!autoConfig.isAutoTradingEnvEnabled()) {
    return res.status(409).json({
      success: false,
      message: 'Cannot resume: AUTO_TRADING_ENABLED env flag is false.',
      code: 'ENV_DISABLED',
    });
  }

  const cfg = await AutoTradingConfig.findOneAndUpdate(
    { key: 'global' },
    {
      $set: {
        paused: false,
        updatedBy: req.user?._id || null,
      },
      $unset: { pausedAt: '', pausedReason: '' },
    },
    { upsert: true, new: true },
  ).lean();

  await auditService.log({
    actor: req.user,
    action: 'AUTO_TRADING_RESUMED',
    resourceType: 'auto_trading',
    resourceId: 'global',
    metadata: {},
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'Auto-trading resumed.',
    data: { paused: cfg.paused },
  });
});

/**
 * Manually trigger one matcher tick (admin probe). Does NOT bypass the kill
 * switch — if paused, it returns the kill-switch status instead.
 */
const runOnce = asyncHandler(async (req, res) => {
  const active = await autoTradingService.isAutoTradingActive();
  if (!active) {
    const killSwitch = await autoTradingService.getKillSwitchStatus();
    return res.status(409).json({
      success: false,
      message: 'Auto-trading is not active (env flag off or paused).',
      code: 'KILL_SWITCH_OFF',
      data: { killSwitch },
    });
  }

  const summary = await autoTradingService.evaluateAll();
  res.status(200).json({ success: true, data: summary });
});

/**
 * Sub-module 2.4.4 — marketplace feedback analytics dashboard. Conversion rate,
 * recommendation accuracy, and listing-volume anomaly detection.
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const sinceDays = (() => {
    const parsed = parseInt(req.query?.sinceDays, 10);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30;
  })();

  const data = await autoTradingAnalytics.getAutoTradingAnalytics({ sinceDays });
  res.status(200).json({ success: true, data });
});

module.exports = { getStatus, pause, resume, runOnce, getAnalytics };
