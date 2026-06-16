const readingService = require('../services/readingService');
const asyncHandler = require('../utils/asyncHandler');
const { asObjectId } = require('../utils/validators');

const createReading = asyncHandler(async (req, res) => {
  const reading = await readingService.createReading(req.body);
  res.status(201).json({ success: true, data: reading });
});

const getReadings = asyncHandler(async (req, res) => {
  const isPrivileged = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const maxLimit = isPrivileged ? 500 : 100;

  const rawNodeId = req.query.nodeId;
  if (rawNodeId !== undefined && rawNodeId !== null && rawNodeId !== '') {
    const nodeId = asObjectId(rawNodeId);
    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'nodeId must be a valid identifier',
      });
    }
    const readings = await readingService.listReadings({
      nodeId,
      limit: req.query.limit,
      maxLimit,
    });

    return res.status(200).json({
      success: true,
      count: readings.length,
      data: readings,
    });
  }

  const readings = await readingService.listReadings({
    limit: req.query.limit,
    maxLimit,
  });

  res.status(200).json({
    success: true,
    count: readings.length,
    data: readings,
  });
});

module.exports = { createReading, getReadings };
