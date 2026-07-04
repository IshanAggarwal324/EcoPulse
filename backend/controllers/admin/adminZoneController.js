const mongoose = require('mongoose');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/apiError');
const GridZone = require('../../models/GridZone');
const User = require('../../models/User');
const auditService = require('../../services/auditService');
const { ROLES } = require('../../auth/roles');
const { ZONE_CODE_RE } = require('../../models/GridZone');
const { getUserZoneIds, invalidateActiveZoneCache } = require('../../utils/nodeOwnership');

const MAX_ZONES_PER_USER = 50;

const toZoneResponse = (zone) => ({
  _id: zone._id,
  code: zone.code,
  name: zone.name,
  description: zone.description,
  active: zone.active,
  createdAt: zone.createdAt,
  updatedAt: zone.updatedAt,
});

const listZones = asyncHandler(async (req, res) => {
  const { active, search } = req.query;
  const filter = {};
  if (active !== undefined) filter.active = active === 'true';
  if (search) {
    const term = String(search).trim().toLowerCase().slice(0, 64);
    if (ZONE_CODE_RE.test(term)) {
      filter.code = term;
    } else {
      filter.$or = [
        { code: { $regex: term, $options: 'i' } },
        { name: { $regex: term, $options: 'i' } },
      ];
    }
  }
  const zones = await GridZone.find(filter).sort({ code: 1 }).lean();
  res.status(200).json({ success: true, count: zones.length, data: zones.map(toZoneResponse) });
});

const createZone = asyncHandler(async (req, res) => {
  const { code, name, description } = req.body;
  if (!code || !name) {
    throw new ApiError('code and name are required', 400, 'INVALID_ZONE');
  }
  try {
    const zone = await GridZone.create({
      code,
      name,
      description: description || '',
      createdBy: req.user?._id || null,
    });
    // Module 8.5 — a newly active zone may expand a grid_operator's scope, so
    // drop the cached active set so it is re-resolved on the next node read.
    invalidateActiveZoneCache();
    await auditService.log({
      actor: req.user,
      action: 'GRID_ZONE_CREATED',
      resourceType: 'grid_zone',
      resourceId: zone._id,
      metadata: { code: zone.code, name: zone.name },
      req,
      severity: 'warn',
    });
    res.status(201).json({ success: true, data: toZoneResponse(zone) });
  } catch (err) {
    if (err?.code === 11000 || err?.name === 'MongoServerError') {
      throw new ApiError('A zone with that code already exists', 409, 'ZONE_CODE_TAKEN');
    }
    throw err;
  }
});

const updateZone = asyncHandler(async (req, res) => {
  const { code } = req.params;
  const { name, description, active } = req.body;
  const zone = await GridZone.findOne({ code: String(code).toLowerCase() });
  if (!zone) throw new ApiError('Zone not found', 404, 'ZONE_NOT_FOUND');

  if (name !== undefined) zone.name = name;
  if (description !== undefined) zone.description = description;
  if (active !== undefined) zone.active = active === true;
  await zone.save();

  // Module 8.5 — an activation/deactivation changes which zones grant
  // visibility. Drop the cached active set so revocation (active:false) takes
  // effect on the very next node read instead of after the TTL.
  invalidateActiveZoneCache();

  await auditService.log({
    actor: req.user,
    action: 'GRID_ZONE_UPDATED',
    resourceType: 'grid_zone',
    resourceId: zone._id,
    metadata: { code: zone.code },
    req,
    severity: 'warn',
  });

  res.status(200).json({ success: true, data: toZoneResponse(zone) });
});

const deleteZone = asyncHandler(async (req, res) => {
  const { code } = req.params;
  const zone = await GridZone.findOne({ code: String(code).toLowerCase() });
  if (!zone) throw new ApiError('Zone not found', 404, 'ZONE_NOT_FOUND');
  await zone.deleteOne();

  // Best-effort: clear this code from any operator it was assigned to so a
  // deleted zone doesn't silently keep granting stale visibility.
  await User.updateMany(
    { assignedZoneIds: zone.code },
    { $pull: { assignedZoneIds: zone.code } },
  ).catch(() => {});

  // Module 8.5 — the deleted zone is gone from the active set; drop the cache so
  // any operator whose assignment is still mid-propagation stops seeing its
  // nodes on the next read.
  invalidateActiveZoneCache();

  await auditService.log({
    actor: req.user,
    action: 'GRID_ZONE_DELETED',
    resourceType: 'grid_zone',
    resourceId: zone._id,
    metadata: { code: zone.code },
    req,
    severity: 'critical',
  });

  res.status(200).json({ success: true, data: {} });
});

/**
 * Assign (replace) the set of zones a grid_operator is responsible for. Only
 * meaningful for grid_operator users; rejected for other roles to avoid storing
 * inert scope data. All codes must exist + be active.
 */
const assignUserZones = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let { zoneIds } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError('Invalid user ID', 400, 'INVALID_USER');
  }
  if (!Array.isArray(zoneIds)) {
    throw new ApiError('zoneIds must be an array of zone codes', 400, 'INVALID_ZONE');
  }

  const user = await User.findById(id);
  if (!user) throw new ApiError('User not found', 404, 'USER_NOT_FOUND');
  if (user.deletedAt) throw new ApiError('Cannot assign zones to a deactivated user', 400, 'INVALID_USER');
  if (user.role !== ROLES.GRID_OPERATOR) {
    throw new ApiError('Zones may only be assigned to grid_operator users', 400, 'INVALID_ROLE');
  }

  // Normalize + dedupe defensively, then validate every code exists and active.
  const requested = [];
  const seen = new Set();
  for (const raw of zoneIds) {
    if (typeof raw !== 'string') continue;
    const c = raw.trim().toLowerCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    requested.push(c);
  }
  if (requested.length > MAX_ZONES_PER_USER) {
    throw new ApiError(`A user may be assigned at most ${MAX_ZONES_PER_USER} zones`, 400, 'INVALID_ZONE');
  }

  if (requested.length) {
    const found = await GridZone.find({ code: { $in: requested }, active: true })
      .select('code')
      .lean();
    const foundCodes = new Set(found.map((z) => z.code));
    const missing = requested.filter((c) => !foundCodes.has(c));
    if (missing.length) {
      throw new ApiError(`Unknown or inactive zone code(s): ${missing.join(', ')}`, 400, 'UNKNOWN_ZONE');
    }
  }

  const previous = getUserZoneIds(user);
  user.assignedZoneIds = requested;
  await user.save();

  await auditService.log({
    actor: req.user,
    action: 'USER_ZONES_ASSIGNED',
    resourceType: 'user',
    resourceId: user._id,
    metadata: { previous, next: requested, userEmail: user.email },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'Zone assignment updated',
    data: { assignedZoneIds: requested },
  });
});

module.exports = {
  listZones,
  createZone,
  updateZone,
  deleteZone,
  assignUserZones,
  MAX_ZONES_PER_USER,
};
