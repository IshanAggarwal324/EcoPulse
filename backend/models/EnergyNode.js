const mongoose = require('mongoose');

const energyNodeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a node name'],
    trim: true,
  },
  nodeType: {
    type: String,
    enum: ['producer', 'consumer', 'prosumer'],
    required: [true, 'Please add a node type'],
  },
  sourceType: {
    type: String,
    enum: ['solar', 'wind', 'home', 'industry', 'other'],
    required: [true, 'Please add a source type'],
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'failed'],
    default: 'active',
  },
  location: {
    type: String,
  },
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('EnergyNode', energyNodeSchema);
