const mongoose = require('mongoose');

/**
 * PublicGridSource (Sub-module 1.5.1).
 *
 * Represents one open government/grid API poller. The poller worker iterates
 * enabled sources, hands each to its provider adapter, and writes the
 * normalized reading into the unified `ingestReading()` pipeline tagged
 * `source: 'public_api'`.
 *
 * Security notes (guardrails 1.5):
 *   - `apiKeyEnvVar` stores the NAME of an env var (e.g. 'EIA_API_KEY'), never
 *     the secret. The adapter reads the actual key from `process.env` at poll
 *     time. A DB dump therefore leaks no credentials.
 *   - The provider host is NOT configurable from this document — it is a
 *     constant inside the adapter (SSRF allowlist). `config` only carries
 *     validated provider-specific knobs (filter IDs, region codes) so an admin
 *     cannot point a poller at an internal host.
 *   - `enabled` defaults to false (fail-closed). A freshly seeded source does
 *     nothing until an admin explicitly turns it on.
 *   - Circuit-breaker state (`circuitState`, `consecutiveFailures`,
 *     `circuitOpenedAt`) persists across restarts so a flapping provider stays
 *     isolated and a process bounce can't reset the defense.
 */

const PROVIDER_KEYS = ['smard_de', 'cea_in', 'eia_us', 'fingrid_fi', 'entsoe_eu'];

const CIRCUIT_STATES = ['closed', 'open', 'half_open'];

const ALLOWED_REGIONS = new Set([
  'DE', // Germany (SMARD)
  'IN', // India (CEA)
  'US', // USA (EIA)
  'FI', // Finland (Fingrid)
  'EU', // ENTSO-E bidding zones
]);

const publicGridSourceSchema = new mongoose.Schema(
  {
    providerKey: {
      type: String,
      required: true,
      enum: PROVIDER_KEYS,
      unique: true,
      trim: true,
      index: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [160, 'displayName cannot exceed 160 characters'],
    },
    attribution: {
      // Terms-of-use / license attribution surfaced in the admin UI.
      // e.g. "Data: SMARD / Bundesnetzagentur, CC BY 4.0"
      type: String,
      trim: true,
      maxlength: [300, 'attribution cannot exceed 300 characters'],
      default: null,
    },
    enabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    pollIntervalMs: {
      type: Number,
      min: [60_000, 'pollIntervalMs must be at least 60000 (1/min)'],
      default: () => require('../config/publicGrid').getDefaultPollInterval(),
    },
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EnergyNode',
      required: true,
      index: true,
    },
    // Provider-specific knobs. Validated against the adapter's allowlist at
    // write time by the service so only safe values are accepted (never raw
    // URLs / hostnames).
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    // NAME of the env var holding the provider API key (e.g. 'EIA_API_KEY'),
    // never the secret itself. Null for keyless providers (SMARD, CEA).
    apiKeyEnvVar: {
      type: String,
      trim: true,
      maxlength: [80, 'apiKeyEnvVar cannot exceed 80 characters'],
      default: null,
    },
    unit: {
      // Grid zones report MW. Home IoT/simulator report kW. Used as a UI label
      // and routed into reading meta so downstream analytics know the scale.
      type: String,
      enum: ['kW', 'MW'],
      default: 'MW',
    },
    maxCapacityMw: {
      // Outlier rejection ceiling (1.5.7). A reading above this is rejected as
      // corrupt rather than stored. Null = inherit the config default.
      type: Number,
      min: 0,
      default: null,
    },

    // ── Poll observability ──────────────────────────────────────────────────
    lastPollAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastPollLatencyMs: { type: Number, default: null, min: 0 },
    lastError: { type: String, default: null },
    lastReadingTimestamp: { type: Date, default: null },

    // ── Circuit breaker (1.5.7) ────────────────────────────────────────────
    circuitState: {
      type: String,
      enum: CIRCUIT_STATES,
      default: 'closed',
      index: true,
    },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    circuitOpenedAt: { type: Date, default: null },
    circuitTrippedReason: { type: String, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

// Compound index so the worker can cheaply find sources due for a poll.
publicGridSourceSchema.index({ enabled: 1, circuitState: 1 });

publicGridSourceSchema.virtual('isCircuitOpen').get(function () {
  return this.circuitState === 'open' || this.circuitState === 'half_open';
});

publicGridSourceSchema.statics.PROVIDER_KEYS = PROVIDER_KEYS;
publicGridSourceSchema.statics.CIRCUIT_STATES = CIRCUIT_STATES;
publicGridSourceSchema.statics.ALLOWED_REGIONS = ALLOWED_REGIONS;

module.exports = mongoose.model('PublicGridSource', publicGridSourceSchema);
