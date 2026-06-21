const readingService = require('../services/readingService');
const asyncHandler = require('../utils/asyncHandler');
const { asObjectId } = require('../utils/validators');
const {
  isPrivileged,
  getOwnedNodeIds,
  assertNodeOwnership,
} = require('../utils/nodeOwnership');

const createReading = asyncHandler(async (req, res) => {
  const reading = await readingService.createReading(req.body);
  res.status(201).json({ success: true, data: reading });
});

const getReadings = asyncHandler(async (req, res) => {
  const privileged = isPrivileged(req.user);
  const maxLimit = privileged ? 500 : 100;

  const rawNodeId = req.query.nodeId;
  if (rawNodeId !== undefined && rawNodeId !== null && rawNodeId !== '') {
    const nodeId = asObjectId(rawNodeId);
    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'nodeId must be a valid identifier',
      });
    }

    if (!privileged) {
      await assertNodeOwnership(req.user._id, nodeId);
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

  if (!privileged) {
    const ownedNodeIds = await getOwnedNodeIds(req.user._id);
    const readings = await readingService.listReadings({
      nodeIds: ownedNodeIds,
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
