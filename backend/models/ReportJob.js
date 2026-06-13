const mongoose = require('mongoose');

const reportJobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  period: {
    type: String,
    enum: ['7d', '14d', '30d'],
    required: true,
  },
  scope: {
    type: String,
    enum: ['personal', 'grid', 'both'],
    required: true,
  },
  delivery: {
    type: String,
    enum: ['chat', 'email'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'failed'],
    default: 'pending',
  },
  sentAt: {
    type: Date,
  },
  error: {
    type: String,
  },
  reportId: {
    type: String,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('ReportJob', reportJobSchema);
