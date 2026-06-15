const mongoose = require('mongoose');
const crypto = require('crypto');

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
    prevHash: {
      type: String,
      default: null,
      select: false,
    },
    entryHash: {
      type: String,
      default: null,
      select: false,
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

// Enforce append-only semantics at the application layer. Audit logs must never
// be updated or deleted by application code — tamper-evidence relies on the hash
// chain remaining intact. The MongoDB TTL index (above) still expires old
// entries because that runs server-side, bypassing Mongoose middleware.
// Authorized maintenance (e.g. the backfill script) passes
// `{ bypassImmutability: true }` to opt out, or uses the raw driver collection.
const IMMUTABLE_MUTATION_HOOKS = [
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
];

IMMUTABLE_MUTATION_HOOKS.forEach((hook) => {
  auditLogSchema.pre(hook, { document: false, query: true }, async function () {
    if (this.getOptions && this.getOptions().bypassImmutability) {
      return;
    }
    throw new Error(
      `AuditLog is append-only: "${hook}" is not permitted. ` +
        'Use create() for new entries, or set { bypassImmutability: true } for authorized maintenance.'
    );
  });
});

auditLogSchema.statics.computeHash = function (entry, prevHash) {
  const payload = JSON.stringify({
    actorId: entry.actorId?.toString() || null,
    actorEmail: entry.actorEmail || null,
    actorRole: entry.actorRole || null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId || null,
    severity: entry.severity,
    ip: entry.ip || null,
    ts: entry.createdAt ? entry.createdAt.toISOString() : new Date().toISOString(),
    prev: prevHash || '',
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
};

auditLogSchema.statics.getLastHash = async function () {
  const last = await this.findOne({}, { entryHash: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .select('+entryHash')
    .lean();
  return last?.entryHash || null;
};

auditLogSchema.statics.verifyChain = async function (limit = 1000) {
  const entries = await this.find({})
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .select('+prevHash +entryHash')
    .lean();

  const broken = [];
  let expectedPrev = null;

  for (const entry of entries) {
    const computed = this.computeHash(entry, entry.prevHash);
    if (entry.entryHash !== computed) {
      broken.push({ id: entry._id, action: entry.action, reason: 'hash_mismatch' });
    }
    if (entry.prevHash !== expectedPrev) {
      broken.push({ id: entry._id, action: entry.action, reason: 'chain_broken' });
    }
    expectedPrev = entry.entryHash;
  }

  return { totalChecked: entries.length, brokenCount: broken.length, broken };
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
