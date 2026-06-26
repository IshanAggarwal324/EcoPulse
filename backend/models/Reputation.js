const mongoose = require('mongoose');

const toLower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

const reputationSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, unique: true, set: toLower },
    nodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnergyNode', default: null, index: true },
    avgScore: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    scoreDistribution: { type: Map, of: Number, default: {} },
    completedTrades: { type: Number, default: 0, min: 0 },
    disputedTrades: { type: Number, default: 0, min: 0 },
    verifiedDeliveries: { type: Number, default: 0, min: 0 },
    totalSettlements: { type: Number, default: 0, min: 0 },
    disputeRate: { type: Number, default: 0, min: 0, max: 1 },
    verifiedDeliveryRate: { type: Number, default: 0, min: 0, max: 1 },
    lastRatingAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Reputation', reputationSchema);
