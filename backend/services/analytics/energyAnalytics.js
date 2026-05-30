const EnergyReading = require('../../models/EnergyReading');

const getEnergyTotals = async (since) => {
  const match = since ? { timestamp: { $gte: since } } : {};

  const [result] = await EnergyReading.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalGenerated: { $sum: '$energyGenerated' },
        totalConsumed: { $sum: '$energyConsumed' },
        readingCount: { $sum: 1 },
      },
    },
  ]);

  return {
    totalGenerated: result?.totalGenerated || 0,
    totalConsumed: result?.totalConsumed || 0,
    readingCount: result?.readingCount || 0,
  };
};

const getRecentReadings = async (limit = 20) => EnergyReading.find()
  .sort({ timestamp: -1 })
  .limit(limit)
  .populate('nodeId', 'name nodeType sourceType status')
  .lean();

module.exports = { getEnergyTotals, getRecentReadings };
