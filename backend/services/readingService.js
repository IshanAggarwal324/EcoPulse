const mongoose = require('mongoose');
const EnergyReading = require('../models/EnergyReading');
const EnergyNode = require('../models/EnergyNode');
const socketBroadcastService = require('./socketBroadcastService');
const timeseriesWriter = require('./timeseries/timeseriesWriter');

const VALID_SOURCES = EnergyReading.VALID_SOURCES;

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Validate the numeric core of a reading. Reused by every entry point so input
 * sanitization is identical for admin, simulator, device, and public-api paths
 * (guardrail 1.2: "Input sanitization reusing validateReadingInput").
 */
const validateReadingInput = ({ nodeId, energyGenerated, energyConsumed }) => {
  if (!nodeId) {
    const err = new Error('nodeId is required');
    err.statusCode = 400;
    throw err;
  }

  if (typeof nodeId !== 'string' || !mongoose.Types.ObjectId.isValid(nodeId)) {
    const err = new Error('nodeId must be a valid identifier');
    err.statusCode = 400;
    throw err;
  }

  const generated = toNumber(energyGenerated);
  const consumed = toNumber(energyConsumed);

  if (generated < 0 || consumed < 0) {
    const err = new Error('energyGenerated and energyConsumed must be non-negative');
    err.statusCode = 400;
    throw err;
  }

  return {
    nodeId,
    energyGenerated: generated,
    energyConsumed: consumed,
  };
};

const normalizeTimestamp = (timestamp) => {
  if (timestamp === undefined || timestamp === null) return new Date();
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

/**
 * Unified ingest pipeline (Sub-module 1.2.4).
 *
 * Single entry point shared by MQTT, HTTP push, the simulator, admin REST, and
 * the public grid poller. Tagged with a `source` and optional provenance fields
 * so the origin of every reading is traceable.
 *
 * @param {object} input
 * @param {string} input.source     one of VALID_SOURCES
 * @param {string} input.nodeId
 * @param {number} input.energyGenerated
 * @param {number} input.energyConsumed
 * @param {Date|string} [input.timestamp]
 * @param {object} [input.meta]     optional provenance: deviceId, providerKey,
 *                                  externalReadingId, unit
 */
const ingestReading = async ({
  source,
  nodeId,
  energyGenerated,
  energyConsumed,
  timestamp,
  meta,
}) => {
  const normalizedSource = VALID_SOURCES.includes(source) ? source : 'admin';
  const input = validateReadingInput({ nodeId, energyGenerated, energyConsumed });

  const provenance = meta && typeof meta === 'object' ? meta : {};

  const doc = {
    nodeId: input.nodeId,
    energyGenerated: input.energyGenerated,
    energyConsumed: input.energyConsumed,
    timestamp: normalizeTimestamp(timestamp),
    source: normalizedSource,
    deviceId: provenance.deviceId || null,
    providerKey: provenance.providerKey || null,
    externalReadingId: provenance.externalReadingId || null,
    unit: provenance.unit === 'MW' ? 'MW' : 'kW',
  };

  // Sub-module 1.3.1 — dual-write to the time-series collection. Legacy
  // `energyreadings` remains the source of truth while TIMESERIES_DUAL_WRITE
  // is on; post-cutover (1.4) the legacy write is skipped.
  const writePromises = [];

  if (timeseriesWriter.shouldWriteLegacy()) {
    writePromises.push(EnergyReading.create(doc));
  } else {
    writePromises.push(Promise.resolve(null));
  }

  writePromises.push(
    timeseriesWriter.writeToTimeseries({
      nodeId: input.nodeId,
      energyGenerated: input.energyGenerated,
      energyConsumed: input.energyConsumed,
      timestamp: doc.timestamp,
      source: normalizedSource,
      unit: doc.unit,
      provenance,
    }),
  );

  const [reading] = await Promise.all(writePromises);

  // The socket payload is the legacy reading (or a synthesized doc post-cutover
  // when legacy writes are disabled).
  const broadcastDoc = reading || doc;
  await socketBroadcastService.emitReadingAndAnalytics(broadcastDoc);
  return broadcastDoc;
};

/**
 * Admin REST wrapper (1.2.4 backward-compat).
 * Kept as a thin wrapper so readingController / admin routes need no changes.
 */
const createReading = (input) =>
  ingestReading({ ...input, source: 'admin' });

/**
 * Socket simulator wrapper (1.2.4 backward-compat).
 *
 * Preserves the historical ephemeral-broadcast behavior: if the nodeId does not
 * resolve to a persisted EnergyNode, the reading is broadcast over the socket
 * without being stored (used by the dashboard demo path).
 */
const ingestSimulatedReading = async (data) => {
  const input = validateReadingInput({
    nodeId: data?.nodeId,
    energyGenerated: data?.energyGenerated,
    energyConsumed: data?.energyConsumed,
  });

  if (mongoose.Types.ObjectId.isValid(input.nodeId)) {
    const nodeExists = await EnergyNode.exists({ _id: input.nodeId });
    if (nodeExists) {
      return ingestReading({ ...input, source: 'simulated' });
    }
  }

  const ephemeral = {
    ...input,
    source: 'simulated',
    timestamp: data?.timestamp || new Date().toISOString(),
  };
  socketBroadcastService.emitNewReading(ephemeral);
  return ephemeral;
};

const listReadings = async ({ nodeId, source, limit = 100, maxLimit = 500 } = {}) => {
  const query = {};
  if (nodeId) {
    query.nodeId = mongoose.Types.ObjectId.isValid(nodeId)
      ? new mongoose.Types.ObjectId(nodeId)
      : nodeId;
  }

  // Sub-module 1.2.6 — optional source filter. Whitelisted against VALID_SOURCES
  // so a caller cannot probe with arbitrary strings / Mongo operators.
  if (source && VALID_SOURCES.includes(source)) {
    query.source = source;
  }

  const cappedLimit = Math.min(parseInt(limit, 10) || 100, maxLimit);

  return EnergyReading.find(query)
    .sort({ timestamp: -1 })
    .limit(cappedLimit)
    .populate('nodeId', 'name nodeType sourceType status');
};

module.exports = {
  ingestReading,
  createReading,
  listReadings,
  ingestSimulatedReading,
  validateReadingInput,
  VALID_SOURCES,
};
