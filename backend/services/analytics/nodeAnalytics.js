const EnergyNode = require('../../models/EnergyNode');

const getNodeStats = async () => {
  const [statusBreakdown, activeNodes, totalNodes] = await Promise.all([
    EnergyNode.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EnergyNode.countDocuments({ status: 'active' }),
    EnergyNode.countDocuments(),
  ]);

  const byStatus = statusBreakdown.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  return { activeNodes, totalNodes, byStatus };
};

module.exports = { getNodeStats };
