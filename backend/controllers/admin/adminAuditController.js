const auditService = require('../../services/auditService');
const asyncHandler = require('../../utils/asyncHandler');

const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { action, actorId, resourceType, resourceId, severity, since, until } = req.query;

  const filters = {};
  if (action) filters.action = action.includes(',') ? action.split(',') : action;
  if (actorId) filters.actorId = actorId;
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

module.exports = { listAuditLogs };
