const mongoose = require('mongoose');
const PublicGridSource = require('../../models/PublicGridSource');
const EnergyNode = require('../../models/EnergyNode');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');
const auditService = require('../../services/auditService');
const publicGridService = require('../../services/publicGrid/publicGridService');
const { validateProviderConfig, providerCatalog, getAdapter } = require('../../services/publicGrid/adapters/registry');
const config = require('../../config/publicGrid');

const PROVIDER_KEYS = PublicGridSource.PROVIDER_KEYS;
const CIRCUIT_STATES = PublicGridSource.CIRCUIT_STATES;

/**
 * Admin PublicGridSource controller (Sub-module 1.5.5).
 *
 * All routes are admin-only (enforced in routes/admin.js). Pollers run
 * server-side only; the admin surface is purely config + manual triggers.
 *
 * Security: `apiKeyEnvVar` accepts only the NAME of an env var (validated
 * against the adapter's canonical name for keyed providers) — the secret itself
 * is never stored, surfaced, or updatable through this API. Source `config`
 * accepts only provider-native knobs (filter IDs / region codes), never hostnames
 * or URLs, so an admin cannot redirect a poller (SSRF guardrail).
 */

const audit = ({ actor, action, source, metadata, req, severity = 'info' }) =>
  auditService.log({
    actor,
    action,
    resourceType: 'public_grid',
    resourceId: source?.providerKey || source?._id || null,
    metadata: { providerKey: source?.providerKey, nodeId: source?.nodeId, ...metadata },
    req,
    severity,
  });

/**
 * Validate + bind a nodeId to a public_api grid-zone node. A public-grid source
 * must target a node whose ingestionMode is public_api so grid MW never lands
 * on a home node (kW) and so ownership/audit scoping stays consistent.
 */
const assertPublicApiNode = async (nodeId) => {
  if (!nodeId || !mongoose.Types.ObjectId.isValid(nodeId)) {
    const err = new Error('nodeId must be a valid identifier');
    err.statusCode = 400;
    throw err;
  }
  const node = await EnergyNode.findById(nodeId).lean().exec();
  if (!node) {
    const err = new Error('Node not found');
    err.statusCode = 404;
    throw err;
  }
  if (node.ingestionMode !== 'public_api') {
    const err = new Error('nodeId must reference a node with ingestionMode "public_api"');
    err.statusCode = 400;
    throw err;
  }
  return node;
};

const findSourceOr404 = async (id) => {
  let query;
  if (mongoose.Types.ObjectId.isValid(id)) {
    query = { _id: id };
  } else if (PROVIDER_KEYS.includes(id)) {
    query = { providerKey: id };
  } else {
    const err = new Error('Source not found');
    err.statusCode = 404;
    throw err;
  }
  const source = await PublicGridSource.findOne(query).exec();
  if (!source) {
    const err = new Error('Source not found');
    err.statusCode = 404;
    throw err;
  }
  return source;
};

// GET /admin/public-grid-sources — list + filter
const listSources = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = publicGridService.buildListFilter(req.query);

  const [sources, total] = await Promise.all([
    PublicGridSource.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'nodeId', select: 'name status ingestionMode' })
      .lean(),
    PublicGridSource.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: sources.map(toSourceResponse),
    meta: paginateResults({ page, limit, total }),
  });
});

// GET /admin/public-grid-sources/providers — the catalog of available providers
const getProviders = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: providerCatalog() });
});

// GET /admin/public-grid-sources/:id
const getSource = asyncHandler(async (req, res) => {
  const source = await findSourceOr404(req.params.id);
  await source.populate({ path: 'nodeId', select: 'name status ingestionMode' });
  res.status(200).json({ success: true, data: toSourceResponse(source) });
});

// POST /admin/public-grid-sources
const createSource = asyncHandler(async (req, res) => {
  const { providerKey, displayName, nodeId, enabled, pollIntervalMs, config: providerConfig, apiKeyEnvVar, attribution, maxCapacityMw } = req.body || {};

  if (!providerKey || !PROVIDER_KEYS.includes(providerKey)) {
    return res.status(400).json({
      success: false,
      message: `providerKey must be one of: ${PROVIDER_KEYS.join(', ')}`,
    });
  }

  await assertPublicApiNode(nodeId);

  const source = await publicGridService.createSource({
    providerKey,
    displayName,
    nodeId,
    enabled,
    pollIntervalMs,
    config: providerConfig,
    apiKeyEnvVar,
    attribution,
    maxCapacityMw,
    createdBy: req.user?._id,
  });

  await audit({
    actor: req.user,
    action: 'PUBLIC_GRID_SOURCE_CREATED',
    source,
    metadata: { enabled: source.enabled, hasConfig: Boolean(source.config) },
    req,
  });

  res.status(201).json({ success: true, data: toSourceResponse(source) });
});

// PATCH /admin/public-grid-sources/:id
const updateSource = asyncHandler(async (req, res) => {
  const source = await findSourceOr404(req.params.id);
  const body = req.body || {};
  const adapter = getAdapter(source.providerKey);

  const updates = {};
  const auditedKeys = [];

  if (body.displayName !== undefined) {
    updates.displayName = String(body.displayName).trim().slice(0, 160) || source.displayName;
    auditedKeys.push('displayName');
  }
  if (body.attribution !== undefined) {
    updates.attribution = body.attribution ? String(body.attribution).trim().slice(0, 300) : null;
    auditedKeys.push('attribution');
  }
  if (body.pollIntervalMs !== undefined) {
    const ms = parseInt(body.pollIntervalMs, 10);
    if (!Number.isFinite(ms) || ms < config.MIN_POLL_INTERVAL_MS) {
      return res.status(400).json({
        success: false,
        message: `pollIntervalMs must be >= ${config.MIN_POLL_INTERVAL_MS}`,
      });
    }
    updates.pollIntervalMs = ms;
    auditedKeys.push('pollIntervalMs');
  }
  if (body.maxCapacityMw !== undefined) {
    if (body.maxCapacityMw !== null && (typeof body.maxCapacityMw !== 'number' || body.maxCapacityMw < 0)) {
      return res.status(400).json({ success: false, message: 'maxCapacityMw must be a non-negative number or null' });
    }
    updates.maxCapacityMw = body.maxCapacityMw;
    auditedKeys.push('maxCapacityMw');
  }
  if (body.nodeId !== undefined) {
    await assertPublicApiNode(body.nodeId);
    updates.nodeId = body.nodeId;
    auditedKeys.push('nodeId');
  }
  if (body.enabled !== undefined) {
    updates.enabled = Boolean(body.enabled);
    auditedKeys.push('enabled');
  }
  if (body.config !== undefined) {
    const validation = validateProviderConfig(source.providerKey, body.config);
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.message });
    }
    updates.config = validation.normalized;
    auditedKeys.push('config');
  }

  // apiKeyEnvVar is accepted only for keyed providers and must match the
  // adapter's canonical env var name (operators can't redirect a key to an
  // arbitrary env var, let alone store a secret here).
  if (body.apiKeyEnvVar !== undefined) {
    if (adapter?.requiresApiKey) {
      const candidate = String(body.apiKeyEnvVar).trim();
      if (candidate && candidate !== adapter.apiKeyEnvVar) {
        return res.status(400).json({
          success: false,
          message: `apiKeyEnvVar for ${source.providerKey} must be "${adapter.apiKeyEnvVar}"`,
        });
      }
      updates.apiKeyEnvVar = adapter.apiKeyEnvVar;
      auditedKeys.push('apiKeyEnvVar');
    } else {
      updates.apiKeyEnvVar = null; // keyless provider
    }
  }

  const updated = await PublicGridSource.findByIdAndUpdate(source._id, updates, {
    new: true,
    runValidators: true,
  }).exec();

  await audit({
    actor: req.user,
    action: 'PUBLIC_GRID_SOURCE_UPDATED',
    source: updated,
    metadata: { updated: auditedKeys },
    req,
    severity: auditedKeys.includes('enabled') ? 'warn' : 'info',
  });

  res.status(200).json({ success: true, data: toSourceResponse(updated) });
});

// POST /admin/public-grid-sources/:id/poll-now — manual trigger (bypasses breaker)
const pollNow = asyncHandler(async (req, res) => {
  const source = await findSourceOr404(req.params.id);
  const result = await publicGridService.pollSource({
    sourceId: source._id,
    manual: true,
    actor: req.user,
    req,
  });

  await audit({
    actor: req.user,
    action: 'PUBLIC_GRID_POLL_NOW',
    source,
    metadata: { ok: result.ok, code: result.code || null, accepted: result.accepted || 0 },
    req,
    severity: result.ok ? 'info' : 'warn',
  });

  res.status(result.ok ? 200 : 502).json({ success: result.ok, data: result });
});

// DELETE /admin/public-grid-sources/:id
const deleteSource = asyncHandler(async (req, res) => {
  const source = await findSourceOr404(req.params.id);
  await source.deleteOne();

  await audit({
    actor: req.user,
    action: 'PUBLIC_GRID_SOURCE_DELETED',
    source,
    metadata: {},
    req,
    severity: 'warn',
  });

  res.status(200).json({ success: true, data: {}, meta: { providerKey: source.providerKey } });
});

// Reset the circuit breaker (closed) without a poll.
const resetCircuit = asyncHandler(async (req, res) => {
  const source = await findSourceOr404(req.params.id);
  source.circuitState = 'closed';
  source.consecutiveFailures = 0;
  source.circuitOpenedAt = null;
  source.circuitTrippedReason = null;
  await source.save();

  await audit({
    actor: req.user,
    action: 'PUBLIC_GRID_CIRCUIT_RESET',
    source,
    metadata: {},
    req,
    severity: 'warn',
  });

  res.status(200).json({ success: true, data: toSourceResponse(source) });
});

/**
 * Serialize a source for the API. Never includes any secret. Exposes whether a
 * key is configured (bool) — not the key, not the env value, not even the env
 * var name unless the provider requires one (and then only the canonical name).
 */
const toSourceResponse = (source) => {
  const doc = source?.toObject ? source.toObject() : source;
  if (!doc) return doc;
  return {
    id: doc._id,
    providerKey: doc.providerKey,
    displayName: doc.displayName,
    attribution: doc.attribution ?? null,
    enabled: doc.enabled,
    pollIntervalMs: doc.pollIntervalMs,
    nodeId: doc.nodeId,
    node: doc.nodeId && typeof doc.nodeId === 'object'
      ? { id: doc.nodeId._id, name: doc.nodeId.name, status: doc.nodeId.status, ingestionMode: doc.nodeId.ingestionMode }
      : doc.nodeId ?? null,
    config: doc.config ?? {},
    apiKeyEnvVar: doc.apiKeyEnvVar ?? null,
    apiKeyConfigured: doc.apiKeyEnvVar ? Boolean(process.env[doc.apiKeyEnvVar]) : null,
    unit: doc.unit,
    maxCapacityMw: doc.maxCapacityMw ?? null,
    lastPollAt: doc.lastPollAt ?? null,
    lastSuccessAt: doc.lastSuccessAt ?? null,
    lastPollLatencyMs: doc.lastPollLatencyMs ?? null,
    lastError: doc.lastError ?? null,
    lastReadingTimestamp: doc.lastReadingTimestamp ?? null,
    circuitState: doc.circuitState,
    consecutiveFailures: doc.consecutiveFailures ?? 0,
    circuitOpenedAt: doc.circuitOpenedAt ?? null,
    circuitTrippedReason: doc.circuitTrippedReason ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

module.exports = {
  listSources,
  getProviders,
  getSource,
  createSource,
  updateSource,
  pollNow,
  resetCircuit,
  deleteSource,
  toSourceResponse,
};
