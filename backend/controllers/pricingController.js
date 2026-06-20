/**
 * Pricing controller (Sub-module 2.1).
 *
 * Exposes the forecast-derived kWh price curve behind `protect` + rate limiting.
 * Node-specific curves are restricted to the node owner (or admin/moderator) so
 * a node's surplus/pricing strategy is never leaked cross-tenant, even though
 * the engine itself is read-only.
 */

const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const pricingEngine = require('../services/pricing/pricingEngine');
const config = require('../config/pricing');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const isAdmin = (req) => req.user?.role === 'admin' || req.user?.role === 'moderator';

/**
 * Resolve + authorize the optional nodeId. Returns the validated id or null
 * (grid aggregate). Sends a 4xx response and returns a sentinel on failure.
 */
async function resolveNodeId(req, res) {
  const raw = req.query.nodeId;
  if (!raw) return { ok: true, nodeId: null };

  if (!isValidObjectId(raw)) {
    res.status(400).json({ success: false, message: 'Invalid nodeId' });
    return { ok: false };
  }

  const node = await EnergyNode.findById(raw).select('_id userId name status').lean();
  if (!node) {
    res.status(404).json({ success: false, message: 'Node not found' });
    return { ok: false };
  }

  // Ownership scoping: only the node owner or an admin may request a
  // node-specific curve. Aggregate (no nodeId) curves are available to all
  // authenticated users since they reflect public grid/market state.
  if (!isAdmin(req) && String(node.userId) !== String(req.user._id)) {
    auditService.log({
      actor: req.user,
      action: 'PRICING_CURVE_DENIED',
      resourceType: 'node',
      resourceId: raw,
      metadata: { reason: 'not_owner' },
      req,
      severity: 'warn',
    });
    res.status(403).json({ success: false, message: 'Not authorized to view this node' });
    return { ok: false };
  }

  return { ok: true, nodeId: raw, node };
}

const getPricingCurve = asyncHandler(async (req, res) => {
  if (!config.isPricingEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'Pricing engine is disabled',
    });
  }

  const resolved = await resolveNodeId(req, res);
  if (!resolved.ok) return;

  const hours = config.clampHours(req.query.hours);
  const bypassCache = req.query.refresh === 'true' && isAdmin(req);

  const result = await pricingEngine.getPricingCurve({
    nodeId: resolved.nodeId,
    hours,
    bypassCache,
  });

  // Audit-friendly log of inputs/outputs (no secrets — pricing is read-only).
  auditService.log({
    actor: req.user,
    action: 'PRICING_CURVE_VIEWED',
    resourceType: 'node',
    resourceId: resolved.nodeId || 'aggregate',
    metadata: {
      hours: result.hours,
      pointCount: result.points.length,
      algoVersion: result.algoVersion,
      forecastAvailable: result.forecastAvailable,
      cached: result.cached,
      bypassCache,
    },
    req,
    severity: 'info',
  });

  res.status(200).json({
    success: true,
    data: result,
  });
});

module.exports = {
  getPricingCurve,
};
