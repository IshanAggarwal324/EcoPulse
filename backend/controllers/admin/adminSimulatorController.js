const mongoose = require('mongoose');
const SimulatorConfig = require('../../models/SimulatorConfig');
const simulatorManager = require('../../services/simulatorManager');
const configStore = require('../../services/simulator/configStore');
const { previewFactors, SOURCE_TYPES } = require('../../services/simulator/profiles');
const auditService = require('../../services/auditService');
const asyncHandler = require('../../utils/asyncHandler');

const FAILURE_MODES = ['offline', 'reduced_output', 'spike', 'intermittent'];
const TARGETS = ['node', 'source'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const validateProfiles = (profiles, res) => {
  if (!Array.isArray(profiles)) {
    res.status(400).json({ success: false, message: 'profiles must be an array' });
    return null;
  }
  const seen = new Set();
  const cleaned = [];
  for (const p of profiles) {
    if (!p || !SOURCE_TYPES.includes(p.sourceType)) {
      res.status(400).json({ success: false, message: `profile sourceType must be one of: ${SOURCE_TYPES.join(', ')}` });
      return null;
    }
    if (seen.has(p.sourceType)) {
      res.status(400).json({ success: false, message: `duplicate profile sourceType: ${p.sourceType}` });
      return null;
    }
    seen.add(p.sourceType);
    if (!isNum(p.capacityGenerateKw) || p.capacityGenerateKw < 0) {
      res.status(400).json({ success: false, message: `capacityGenerateKw invalid for ${p.sourceType}` });
      return null;
    }
    if (!isNum(p.capacityConsumeKw) || p.capacityConsumeKw < 0) {
      res.status(400).json({ success: false, message: `capacityConsumeKw invalid for ${p.sourceType}` });
      return null;
    }
    cleaned.push({
      sourceType: p.sourceType,
      capacityGenerateKw: p.capacityGenerateKw,
      capacityConsumeKw: p.capacityConsumeKw,
    });
  }
  return cleaned;
};

const validateFailureModes = (modes, res) => {
  if (!Array.isArray(modes)) {
    res.status(400).json({ success: false, message: 'failureModes must be an array' });
    return null;
  }
  const cleaned = [];
  for (const m of modes) {
    if (!m || !FAILURE_MODES.includes(m.mode)) {
      res.status(400).json({ success: false, message: `failure mode must be one of: ${FAILURE_MODES.join(', ')}` });
      return null;
    }
    const target = TARGETS.includes(m.target) ? m.target : 'node';
    if (target === 'node' && m.nodeId && !mongoose.Types.ObjectId.isValid(m.nodeId)) {
      res.status(400).json({ success: false, message: 'failureMode nodeId is invalid' });
      return null;
    }
    if (target === 'source' && !SOURCE_TYPES.includes(m.sourceType)) {
      res.status(400).json({ success: false, message: `failureMode sourceType must be one of: ${SOURCE_TYPES.join(', ')}` });
      return null;
    }
    const probability = isNum(m.probability) ? Math.min(1, Math.max(0, m.probability)) : 0;
    const durationTicks = Number.isInteger(m.durationTicks) && m.durationTicks >= 1 ? m.durationTicks : 1;
    const outputMultiplier = isNum(m.outputMultiplier) && m.outputMultiplier >= 0 ? m.outputMultiplier : 0;
    cleaned.push({
      label: typeof m.label === 'string' ? m.label.slice(0, 80) : '',
      target,
      nodeId: target === 'node' && m.nodeId ? m.nodeId : null,
      sourceType: target === 'source' ? m.sourceType : null,
      mode: m.mode,
      probability,
      durationTicks,
      outputMultiplier,
      enabled: m.enabled !== false,
    });
  }
  return cleaned;
};

// GET /admin/simulator/config
const getConfig = asyncHandler(async (req, res) => {
  const config = await SimulatorConfig.getOrCreate();
  res.status(200).json({
    success: true,
    data: { config, status: simulatorManager.getStatus() },
  });
});

// PUT /admin/simulator/config
const updateConfig = asyncHandler(async (req, res) => {
  const { enabled, intervalMs, jitterMs, profiles, failureModes } = req.body;

  const config = await SimulatorConfig.getOrCreate();

  if (enabled !== undefined) config.enabled = !!enabled;

  if (intervalMs !== undefined) {
    if (!isNum(intervalMs) || intervalMs < 1000) {
      return res.status(400).json({ success: false, message: 'intervalMs must be a number >= 1000' });
    }
    config.intervalMs = Math.round(intervalMs);
  }

  if (jitterMs !== undefined) {
    if (!isNum(jitterMs) || jitterMs < 0) {
      return res.status(400).json({ success: false, message: 'jitterMs must be a number >= 0' });
    }
    config.jitterMs = Math.round(jitterMs);
  }

  if (profiles !== undefined) {
    const cleaned = validateProfiles(profiles, res);
    if (!cleaned) return undefined;
    config.profiles = cleaned;
  }

  if (failureModes !== undefined) {
    const cleaned = validateFailureModes(failureModes, res);
    if (!cleaned) return undefined;
    config.failureModes = cleaned;
  }

  config.updatedBy = req.user._id;
  await config.save();

  // Propagate to the live runner (embedded or CLI picks it up next tick).
  await configStore.reload();
  await simulatorManager.reload();

  await auditService.log({
    actor: req.user,
    action: 'SIMULATOR_CONFIG_UPDATED',
    resourceType: 'simulator',
    resourceId: config.key,
    metadata: {
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      jitterMs: config.jitterMs,
      profileCount: config.profiles.length,
      failureModeCount: config.failureModes.length,
    },
    req,
  });

  res.status(200).json({
    success: true,
    data: { config, status: simulatorManager.getStatus() },
  });
});

// POST /admin/simulator/restart
const restart = asyncHandler(async (req, res) => {
  await simulatorManager.restart();

  await auditService.log({
    actor: req.user,
    action: 'SIMULATOR_RESTARTED',
    resourceType: 'simulator',
    resourceId: 'runner',
    metadata: simulatorManager.getStatus(),
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    data: simulatorManager.getStatus(),
  });
});

// POST /admin/simulator/reset
const resetConfig = asyncHandler(async (req, res) => {
  const config = await SimulatorConfig.resetToDefaults(req.user._id);
  await configStore.reload();
  await simulatorManager.reload();

  await auditService.log({
    actor: req.user,
    action: 'SIMULATOR_CONFIG_RESET',
    resourceType: 'simulator',
    resourceId: config.key,
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    data: { config, status: simulatorManager.getStatus() },
  });
});

// GET /admin/simulator/readings — live preview ring buffer
const getRecentReadings = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 60);
  const readings = simulatorManager.getRecentReadings().slice(0, limit);
  res.status(200).json({ success: true, data: readings });
});

// GET /admin/simulator/preview?sourceType=solar — hourly curve factors
const getPreview = asyncHandler(async (req, res) => {
  const { sourceType } = req.query;
  if (!SOURCE_TYPES.includes(sourceType)) {
    return res.status(400).json({
      success: false,
      message: `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`,
    });
  }
  res.status(200).json({
    success: true,
    data: { sourceType, points: previewFactors(sourceType) },
  });
});

module.exports = {
  getConfig,
  updateConfig,
  restart,
  resetConfig,
  getRecentReadings,
  getPreview,
};
