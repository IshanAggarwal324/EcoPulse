const mongoose = require('mongoose');

const VALID_SEVERITIES = ['info', 'warn', 'critical'];
const VALID_RESOURCE_TYPES = ['user', 'node', 'trade', 'report_job', 'api', 'sync', 'auth', 'simulator'];

const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorEmail: {
      type: String,
      default: null,
    },
    actorRole: {
      type: String,
      default: null,
    },
    action: {
      type: String,
      required: true,
    },
    resourceType: {
      type: String,
      enum: VALID_RESOURCE_TYPES,
      required: true,
    },
    resourceId: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
    severity: {
      type: String,
      enum: VALID_SEVERITIES,
      default: 'info',
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });
auditLogSchema.index({ severity: 1, createdAt: -1 });

const ttlDays = parseInt(process.env.AUDIT_LOG_TTL_DAYS || '90', 10);
if (Number.isFinite(ttlDays) && ttlDays > 0) {
  auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

module.exports = mongoose.model('AuditLog', auditLogSchema);
