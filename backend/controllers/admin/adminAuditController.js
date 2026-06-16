const auditService = require('../../services/auditService');
const asyncHandler = require('../../utils/asyncHandler');
const { asObjectId } = require('../../utils/validators');

const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { action, resourceType, resourceId, severity, since, until } = req.query;

  const filters = {};
  if (action) filters.action = action.includes(',') ? action.split(',') : action;

  if (req.query.actorId) {
    const safeActorId = asObjectId(req.query.actorId);
    if (!safeActorId) {
      return res.status(400).json({
        success: false,
        message: 'actorId must be a valid identifier',
      });
    }
    filters.actorId = safeActorId;
  }
  if (resourceType) filters.resourceType = resourceType;
  if (resourceId) filters.resourceId = resourceId;
  if (severity) filters.severity = severity;
  if (since) filters.since = since;
  if (until) filters.until = until;

  const result = await auditService.query({ filters, page, limit });

  res.status(200).json({
    success: true,
    data: result.data,
    meta: result.meta,
  });
});

const verifyAuditIntegrity = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '1000', 10), 10000);
  const result = await auditService.verifyChain(limit);

  res.status(200).json({
    success: true,
    data: result,
  });
});

module.exports = { listAuditLogs, verifyAuditIntegrity };
