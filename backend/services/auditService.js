const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { parsePagination, paginateResults } = require('../utils/paginate');

const log = async ({
  actor,
  action,
  resourceType,
  resourceId,
  metadata,
  req,
  severity = 'info',
}) => {
  try {
    const entry = {
      actorId: actor?._id || actor?.id || null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      action,
      resourceType,
      resourceId: resourceId ? String(resourceId) : null,
      metadata: metadata || null,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      userAgent: req?.headers?.['user-agent'] || null,
      severity,
    };

    const prevHash = await AuditLog.getLastHash();
    entry.prevHash = prevHash;
    entry.createdAt = new Date();
    entry.entryHash = AuditLog.computeHash(entry, prevHash);

    await AuditLog.create(entry);
  } catch (error) {
    console.error('[Audit] Failed to write audit log:', error.message);
  }
};

const resolveActorFromWallet = async (walletAddress) => {
  if (!walletAddress) return null;
  try {
    const user = await User.findOne({
      walletAddress: { $regex: new RegExp(`^${walletAddress}$`, 'i') },
    }).lean();
    return user;
  } catch {
    return null;
  }
};

const query = async ({ filters = {}, page = 1, limit = 20 } = {}) => {
  const { action, actorId, resourceType, resourceId, severity, since, until } = filters;

  const query = {};

  if (action) {
    const actions = Array.isArray(action) ? action : [action];
    query.action = actions.length === 1 ? actions[0] : { $in: actions };
  }

  if (actorId) {
    query.actorId = actorId;
  }

  if (resourceType) {
    query.resourceType = resourceType;
  }

  if (resourceId) {
    query.resourceId = String(resourceId);
  }

  if (severity) {
    query.severity = severity;
  }

  if (since || until) {
    query.createdAt = {};
    if (since) query.createdAt.$gte = new Date(since);
    if (until) query.createdAt.$lte = new Date(until);
  }

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });
  const sort = { createdAt: -1 };

  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort(sort).skip(skip).limit(l).lean(),
    AuditLog.countDocuments(query),
  ]);

  return {
    data: logs,
    meta: paginateResults({ page: p, limit: l, total }),
  };
};

module.exports = { log, query, resolveActorFromWallet, verifyChain: (...args) => AuditLog.verifyChain(...args) };
