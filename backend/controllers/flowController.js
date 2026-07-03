/**
 * Energy-flow controller — Module 9.1.
 *
 * Thin HTTP layer: auth/scope + input validation live in the service so they
 * can be unit-tested without a DB. The route is mounted under the guarded
 * `/api/v1/analytics` chain (protect + email/password guards + rate limiter),
 * so every request reaching here is authenticated.
 */
const asyncHandler = require('../utils/asyncHandler');
const flowService = require('../services/analytics/flowService');

const getEnergyFlow = asyncHandler(async (req, res) => {
  const data = await flowService.getEnergyFlow({
    window: req.query.window,
    user: req.user,
    query: req.query,
  });

  res.status(200).json({ success: true, data });
});

module.exports = { getEnergyFlow };
