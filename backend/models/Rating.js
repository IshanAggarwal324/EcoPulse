const mongoose = require('mongoose');

const toLower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

const ratingSchema = new mongoose.Schema(
  {
    raterWallet: { type: String, required: true, set: toLower, index: true },
    ratedWallet: { type: String, required: true, set: toLower, index: true },
    listingId: { type: Number, required: true, index: true },
    tradeTxHash: { type: String, required: true, set: toLower, index: true },
    score: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: (v) => Number.isInteger(v),
        message: 'Score must be an integer between 1 and 5',
      },
    },
    comment: { type: String, default: '', maxlength: 500, trim: true },
    nodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnergyNode', default: null, index: true },
    chainId: { type: Number, default: null },
  },
  { timestamps: true },
);

ratingSchema.index({ raterWallet: 1, tradeTxHash: 1 }, { unique: true });
ratingSchema.index({ ratedWallet: 1, createdAt: -1 });
ratingSchema.index({ listingId: 1, createdAt: -1 });
ratingSchema.index({ nodeId: 1, createdAt: -1 });

module.exports = mongoose.model('Rating', ratingSchema);
