const mongoose = require('mongoose');
const DeviceCredential = require('../../models/DeviceCredential');
const EnergyNode = require('../../models/EnergyNode');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');
const deviceService = require('../../services/deviceService');

const VALID_STATUSES = DeviceCredential.STATUS_VALUES;
const VALID_TIERS = DeviceCredential.RATE_LIMIT_TIERS;

/**
 * Admin Device Credential controller (Sub-modules 1.1.2 + 1.1.5).
 *
 * All endpoints are admin-only (enforced in routes). Plaintext API keys are
 * surfaced EXACTLY ONCE on create / rotate responses and are never persisted,
 * logged, or retrievable afterwards — losing one requires a rotation.
 */

const buildListFilter = (query) => {
  const filter = {};

  if (query.status && VALID_STATUSES.includes(query.status)) {
    filter.status = query.status;
  }
  if (query.rateLimitTier && VALID_TIERS.includes(query.rateLimitTier)) {
    filter.rateLimitTier = query.rateLimitTier;
  }
  if (query.nodeId && mongoose.Types.ObjectId.isValid(query.nodeId)) {
    filter.nodeId = new mongoose.Types.ObjectId(query.nodeId);
  }

  return filter;
};

const listDevices = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = buildListFilter(req.query);

  const [devices, total] = await Promise.all([
    DeviceCredential.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'nodeId', select: 'name status ingestionMode userId' })
      .lean(),
    DeviceCredential.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: devices.map((d) => deviceService.toDeviceResponse(d)),
    meta: paginateResults({ page, limit, total }),
  });
});

const getDevice = asyncHandler(async (req, res) => {
  const device = await findDeviceOr404(req.params.id);
  await device.populate({ path: 'nodeId', select: 'name status ingestionMode userId' });
  res.status(200).json({
    success: true,
    data: deviceService.toDeviceResponse(device),
  });
});

const createDevice = asyncHandler(async (req, res) => {
  const {
    nodeId,
    ownerId,
    label,
    mqttClientId,
    rateLimitTier,
    maxCapacityKw,
    allowedTopics,
  } = req.body;

  const { device, plaintextApiKey } = await deviceService.provisionDevice({
    nodeId,
    ownerId,
    label,
    mqttClientId,
    rateLimitTier,
    maxCapacityKw,
    allowedTopics,
    createdBy: req.user?._id,
  });

  await deviceService.logDeviceEvent({
    actor: req.user,
    action: 'DEVICE_PROVISIONED',
    device,
    metadata: { rateLimitTier: device.rateLimitTier, hasMqttClientId: Boolean(device.mqttClientId) },
    req,
  });

  // Attach the one-time plaintext key so the response can return it.
  device.__plaintextApiKey = plaintextApiKey;

  res.status(201).json({
    success: true,
    message: 'Device provisioned. Store the API key now — it cannot be retrieved again.',
    data: deviceService.toDeviceResponse(device, { includeSecrets: true }),
  });
});

const updateDevice = asyncHandler(async (req, res) => {
  const device = await findDeviceOr404(req.params.id);
  const { label, mqttClientId, rateLimitTier, maxCapacityKw, allowedTopics, ownerId } = req.body;

  const updates = {};

  if (label !== undefined) updates.label = label?.toString().trim() || null;
  if (mqttClientId !== undefined) updates.mqttClientId = mqttClientId?.toString().trim() || null;
  if (rateLimitTier !== undefined) {
    if (!VALID_TIERS.includes(rateLimitTier)) {
      return res.status(400).json({
        success: false,
        message: `rateLimitTier must be one of: ${VALID_TIERS.join(', ')}`,
      });
    }
    updates.rateLimitTier = rateLimitTier;
  }
  if (maxCapacityKw !== undefined) {
    if (maxCapacityKw !== null && (typeof maxCapacityKw !== 'number' || maxCapacityKw < 0)) {
      return res.status(400).json({ success: false, message: 'maxCapacityKw must be a non-negative number or null' });
    }
    updates.maxCapacityKw = maxCapacityKw;
  }
  if (allowedTopics !== undefined) {
    if (!Array.isArray(allowedTopics)) {
      return res.status(400).json({ success: false, message: 'allowedTopics must be an array of strings' });
    }
    updates.allowedTopics = Array.from(
      new Set(allowedTopics.map((t) => String(t).trim()).filter(Boolean)),
    );
  }
  if (ownerId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ success: false, message: 'Invalid ownerId' });
    }
    const node = await EnergyNode.findById(device.nodeId).lean();
    if (node && String(node.userId) !== String(ownerId)) {
      return res.status(403).json({ success: false, message: 'ownerId does not match the bound node owner' });
    }
  }

  const updated = await DeviceCredential.findByIdAndUpdate(device._id, updates, {
    new: true,
    runValidators: true,
  });

  await deviceService.logDeviceEvent({
    actor: req.user,
    action: 'DEVICE_UPDATED',
    device: updated,
    metadata: { updates: Object.keys(updates) },
    req,
  });

  res.status(200).json({
    success: true,
    data: deviceService.toDeviceResponse(updated),
  });
});

const rotateDeviceKey = asyncHandler(async (req, res) => {
  const device = await findDeviceOr404(req.params.id);
  const plaintextApiKey = await deviceService.rotateApiKey(device);

  await device.populate('nodeId');
  device.apiKeyVersion += 1;
  device.__plaintextApiKey = plaintextApiKey;

  await deviceService.logDeviceEvent({
    actor: req.user,
    action: 'DEVICE_KEY_ROTATED',
    device,
    metadata: { apiKeyVersion: device.apiKeyVersion },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'API key rotated. The previous key is now invalid. Store the new key now — it cannot be retrieved again.',
    data: deviceService.toDeviceResponse(device, { includeSecrets: true }),
  });
});

const revokeDevice = asyncHandler(async (req, res) => {
  const device = await findDeviceOr404(req.params.id);
  const { revoke = true, reason } = req.body || {};

  if (typeof revoke !== 'boolean') {
    return res.status(400).json({ success: false, message: 'revoke must be a boolean' });
  }

  await deviceService.setRevoked(device, { revoked, reason });

  await deviceService.logDeviceEvent({
    actor: req.user,
    action: revoke ? 'DEVICE_REVOKED' : 'DEVICE_REACTIVATED',
    device,
    metadata: { reason: reason || null },
    req,
    severity: revoke ? 'warn' : 'info',
  });

  const refreshed = await DeviceCredential.findById(device._id).lean();
  res.status(200).json({
    success: true,
    data: deviceService.toDeviceResponse(refreshed),
  });
});

const deleteDevice = asyncHandler(async (req, res) => {
  const device = await findDeviceOr404(req.params.id);
  await device.deleteOne();

  await deviceService.logDeviceEvent({
    actor: req.user,
    action: 'DEVICE_DELETED',
    device,
    metadata: {},
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    data: {},
    meta: { deviceId: device.deviceId },
  });
});

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

const findDeviceOr404 = async (idOrDeviceId) => {
  let query;
  if (mongoose.Types.ObjectId.isValid(idOrDeviceId)) {
    query = { _id: idOrDeviceId };
  } else {
    query = { deviceId: idOrDeviceId };
  }
  const device = await DeviceCredential.findOne(query).exec();
  if (!device) {
    const err = new Error('Device not found');
    err.statusCode = 404;
    throw err;
  }
  return device;
};

module.exports = {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  rotateDeviceKey,
  revokeDevice,
  deleteDevice,
};
