const healthService = require('../../services/healthService');
const asyncHandler = require('../../utils/asyncHandler');

// The endpoint itself is healthy as long as the backend can respond; the
// `overall` field reports the health of downstream services. Returning 200 even
// when subsystems are down lets the dashboard render component detail instead
// of surfacing a network error.
const getHealth = asyncHandler(async (req, res) => {
  const health = await healthService.getHealth();

  res.status(200).json({
    success: true,
    data: health,
  });
});

module.exports = {
  getHealth,
};
