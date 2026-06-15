const readingService = require('../services/readingService');
const asyncHandler = require('../utils/asyncHandler');

const createReading = asyncHandler(async (req, res) => {
  const reading = await readingService.createReading(req.body);
  res.status(201).json({ success: true, data: reading });
});

const getReadings = asyncHandler(async (req, res) => {
  const isPrivileged = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const maxLimit = isPrivileged ? 500 : 100;

  const readings = await readingService.listReadings({
    nodeId: req.query.nodeId,
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
