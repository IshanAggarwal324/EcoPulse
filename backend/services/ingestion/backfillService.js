/**
 * Backfill / replay tool (Sub-module 1.4.3).
 *
 * Admin endpoint to import historical readings (CEA JSON / OPSD CSV / generic
 * JSON arrays) for model warm-up or restoring history. Every imported reading
 * flows through the unified `ingestReading()` pipeline, so it lands in the same
 * store(s), gets the right `source`/`providerKey`/`externalReadingId` tags, AND
 * broadcasts over the socket (Sub-module 1.4.4 — real-time path unchanged).
 *
 * Guardrails (1.4):
 *   - Admin-only + audited (enforced by the route, not here).
 *   - Max batch size enforced (default 5000, configurable).
 *   - Demo/seed data tagged `source: simulated`. Importing `simulated` data in
 *     production requires an explicit confirmation flag so it can never be
 *     mixed with billing/trading decisions by accident.
 *   - Per-row validation reuses `validateReadingInput` (no negative/NaN,
 *     valid nodeId). Rows that fail validation are skipped and counted, never
 *     aborting the whole batch.
 *
 * Input formats:
 *   - JSON:  { readings: [{ nodeId, energyGenerated, energyConsumed, timestamp?, messageId? }] }
 *   - CSV :  raw text with header row; nodeId,energyGenerated,energyConsumed,timestamp
 */

const mongoose = require('mongoose');
const readingService = require('../readingService');
const EnergyNode = require('../../models/EnergyNode');
const ingestionMode = require('../../config/ingestionMode');
const { VALID_SOURCES } = require('../../models/EnergyReading');

const DEFAULT_MAX_BATCH = 5000;
const ABSOLUTE_MAX_BATCH = 50000;

const getMaxBatchSize = () => {
  const parsed = parseInt(process.env.INGESTION_BACKFILL_MAX_BATCH || String(DEFAULT_MAX_BATCH), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_BATCH;
  return Math.min(parsed, ABSOLUTE_MAX_BATCH);
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toFinite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Minimal CSV parser (no external dep). Only the columns we need. Tolerates
 * trailing whitespace, blank lines, and an optional BOM.
 */
const parseCsv = (raw) => {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());

  const idx = (name) => headers.indexOf(name);
  const iNode = idx('nodeid');
  const iGen = idx('energygenerated');
  const iCon = idx('energyconsumed');
  const iTs = idx('timestamp');
  const iExt = idx('externalreadingid');

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    rows.push({
      nodeId: iNode >= 0 ? cols[iNode]?.trim() : undefined,
      energyGenerated: iGen >= 0 ? toFinite(cols[iGen]) : undefined,
      energyConsumed: iCon >= 0 ? toFinite(cols[iCon]) : undefined,
      timestamp: iTs >= 0 ? cols[iTs]?.trim() : undefined,
      externalReadingId: iExt >= 0 ? cols[iExt]?.trim() : undefined,
    });
  }
  return rows;
};

/**
 * Normalize the inbound payload into an array of raw reading objects.
 * Accepts either a JSON body or a CSV string (`format: 'csv'` / `contentType`).
 */
const extractRows = (body) => {
  if (typeof body === 'string') return parseCsv(body);
  if (body && typeof body === 'object') {
    if (typeof body.csv === 'string') return parseCsv(body.csv);
    if (Array.isArray(body.readings)) return body.readings;
    if (Array.isArray(body)) return body;
  }
  return [];
};

/**
 * Validate a single normalized row into an ingestable envelope, or return null.
 * Returns `{ envelope } | { error }`.
 */
const validateRow = (row, { defaultSource }) => {
  if (!row || typeof row !== 'object') return { error: 'row is not an object' };

  const nodeId = row.nodeId || row.node_id;
  if (!nodeId || !mongoose.Types.ObjectId.isValid(nodeId)) {
    return { error: 'nodeId is missing or not a valid ObjectId' };
  }

  const energyGenerated = toFinite(row.energyGenerated ?? row.energy_generated);
  const energyConsumed = toFinite(row.energyConsumed ?? row.energy_consumed);
  if (!isNum(energyGenerated) || !isNum(energyConsumed)) {
    return { error: 'energyGenerated/energyConsumed must be finite numbers' };
  }
  if (energyGenerated < 0 || energyConsumed < 0) {
    return { error: 'energy values must be non-negative' };
  }

  const source = (row.source || defaultSource || 'public_api').toLowerCase();
  if (!VALID_SOURCES.includes(source)) {
    return { error: `source must be one of: ${VALID_SOURCES.join(', ')}` };
  }

  // Build a stable external id for dedup when the row doesn't carry one. This
  // makes re-importing the same dataset idempotent at the index level.
  let externalReadingId = row.externalReadingId || row.external_reading_id || null;
  if (!externalReadingId) {
    const ts = row.timestamp ? new Date(row.timestamp).getTime() : '';
    externalReadingId = `backfill:${nodeId}:${ts}:${energyGenerated}:${energyConsumed}`;
  }

  let timestamp = null;
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    timestamp = Number.isNaN(d.getTime()) ? null : d;
    if (!timestamp) return { error: 'timestamp is not a valid date' };
  }

  return {
    envelope: {
      source,
      nodeId,
      energyGenerated,
      energyConsumed,
      timestamp,
      meta: {
        providerKey: row.providerKey || row.provider_key || null,
        externalReadingId,
        unit: row.unit === 'MW' ? 'MW' : 'kW',
      },
    },
  };
};

/**
 * Run a backfill batch. Returns a structured result; never throws — row-level
 * failures are collected.
 *
 * @param {object} opts
 * @param {object} opts.body     Parsed request body or CSV string.
 * @param {string} [opts.defaultSource] Source applied when a row omits one.
 * @param {boolean} [opts.dryRun] Validate + count without writing.
 * @param {boolean} [opts.confirmSimulated] Explicit consent to import simulated
 *                                          data in production.
 */
const runBackfill = async ({
  body,
  defaultSource = 'public_api',
  dryRun = false,
  confirmSimulated = false,
  actor = null,
}) => {
  const rows = extractRows(body);
  const maxBatch = getMaxBatchSize();

  if (rows.length === 0) {
    const err = new Error('No readings supplied. Send a JSON { readings: [...] } body or a CSV string.');
    err.statusCode = 400;
    throw err;
  }

  if (rows.length > maxBatch) {
    const err = new Error(`Batch size ${rows.length} exceeds the maximum of ${maxBatch} (INGESTION_BACKFILL_MAX_BATCH).`);
    err.statusCode = 413;
    throw err;
  }

  // Guardrail: prevent accidental mixing of simulated seed data into a live
  // billing/trading environment. Allowed only with explicit confirmation.
  const resolvedDefaultSource = VALID_SOURCES.includes(String(defaultSource).toLowerCase())
    ? String(defaultSource).toLowerCase()
    : 'public_api';
  const importsSimulated = rows.some(
    (r) => (r?.source || resolvedDefaultSource).toLowerCase() === 'simulated',
  );
  if (importsSimulated && ingestionMode.isProduction() && !confirmSimulated) {
    const err = new Error(
      'Importing source=simulated data in production requires confirmSimulated=true ' +
        '(so demo/seed data is never mixed with billing/trading decisions).',
    );
    err.statusCode = 400;
    throw err;
  }

  // Pre-validate node existence once (distinct nodeIds) so we can reject
  // unknown nodes fast instead of one DB lookup per row.
  const nodeIds = [...new Set(rows.map((r) => String(r?.nodeId || r?.node_id || '')).filter(Boolean))];
  const validNodeIds = new Set(
    nodeIds.filter((id) => mongoose.Types.ObjectId.isValid(id)),
  );
  if (validNodeIds.size > 0) {
    const existing = await EnergyNode.find({ _id: { $in: [...validNodeIds] } })
      .select('_id')
      .lean();
    existing.forEach((n) => validNodeIds.delete(String(n._id)));
    // remaining validNodeIds are non-existent
  }
  const missingNodeIds = new Set(validNodeIds);

  const result = {
    requested: rows.length,
    accepted: 0,
    rejected: 0,
    dryRun,
    maxBatch,
    errors: [],
    bySource: {},
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowLabel = `row[${i}]`;

    if (row?.nodeId && missingNodeIds.has(String(row.nodeId))) {
      result.rejected += 1;
      result.errors.push({ row: i, error: 'nodeId does not reference an existing EnergyNode' });
      continue;
    }

    const { envelope, error } = validateRow(row, { defaultSource: resolvedDefaultSource });
    if (error || !envelope) {
      result.rejected += 1;
      result.errors.push({ row: i, error: error || `${rowLabel} invalid` });
      continue;
    }

    result.bySource[envelope.source] = (result.bySource[envelope.source] || 0) + 1;

    if (dryRun) {
      result.accepted += 1;
      continue;
    }

    try {
      await readingService.ingestReading(envelope);
      result.accepted += 1;
    } catch (err) {
      result.rejected += 1;
      result.errors.push({ row: i, error: String(err.message || err).slice(0, 200) });
    }
  }

  // Cap the error list so a pathological payload can't blow up the response.
  if (result.errors.length > 50) {
    result.errors = result.errors.slice(0, 50);
    result.errorsTruncated = true;
  }

  return result;
};

module.exports = {
  runBackfill,
  parseCsv,
  validateRow,
  extractRows,
  getMaxBatchSize,
  DEFAULT_MAX_BATCH,
  ABSOLUTE_MAX_BATCH,
};
