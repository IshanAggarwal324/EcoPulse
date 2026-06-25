const BlockchainService = require('./blockchainService');
const Settlement = require('../models/Settlement');
const Trade = require('../models/Trade');
const EnergyNode = require('../models/EnergyNode');
const EnergyReading = require('../models/EnergyReading');
const User = require('../models/User');
const AnomalyEvent = require('../models/AnomalyEvent');
const auditService = require('./auditService');
const socketBroadcastService = require('./socketBroadcastService');
const { logBackgroundError, logger } = require('../utils/logger');
const { WALLET_REGEX, escapeRegex } = require('../utils/validators');

/**
 * Reconciliation Service — Module 5.2.3 / 5.2.7
 *
 * For each settled purchase, compares the on-chain delivered energy (the
 * `energyAmount` from the EnergyPurchased event, treated as kWh) against the
 * measured off-chain meter generation for the seller's nodes over the trade
 * window (listing `createdAt` → purchase `blockTimestamp`).
 *
 * Off-chain energy is the trapezoidal integral of instantaneous power samples
 * (energyGenerated, kW) over elapsed hours → kWh, which is the physically
 * correct conversion from power telemetry to delivered energy.
 *
 * Flags:
 *   OVER_DELIVERY  off-chain generation exceeds on-chain amount beyond tolerance
 *   UNDER_DELIVERY off-chain generation is below on-chain amount beyond tolerance
 *   READING_GAP    no usable meter readings exist for the trade window
 */

const getTolerancePct = () => {
  const parsed = parseFloat(process.env.SETTLEMENT_TOLERANCE_PCT || '5');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
};

// Above this anomaly score (0–1) a reconciliation mismatch is auto-flagged for
// dispute rather than just recorded (Module 5.2.7 tie-in).
const getAutoFlagThreshold = () => {
  const parsed = parseFloat(process.env.SETTLEMENT_AUTOFLAG_SCORE || '0.8');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.8;
};

// Cap per tick so a huge backlog can never pin the event loop / DB for minutes.
const getReconcileBatchSize = () => {
  const parsed = parseInt(process.env.SETTLEMENT_RECONCILE_BATCH || '50', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
};

const MS_PER_HOUR = 3600 * 1000;

/**
 * Trapezoidal integration of power samples → energy (kWh).
 * `samples` must be sorted ascending by timestamp.
 */
function integrateEnergyKwh(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  if (samples.length === 1) return 0;

  let energyKwh = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dtHours = (curr.t - prev.t) / MS_PER_HOUR;
    if (dtHours <= 0) continue;
    // MW readings are scaled to kWh.
    const unitScale = (curr.unit === 'MW' || prev.unit === 'MW') ? 1000 : 1;
    const avgPowerKw = ((prev.kw + curr.kw) / 2) * unitScale;
    energyKwh += avgPowerKw * dtHours;
  }
  return energyKwh;
}

/**
 * Resolve the seller's energy nodes via wallet → user → nodes.
 */
async function resolveSellerNodes(sellerWallet) {
  if (!sellerWallet) return [];
  // Validate shape BEFORE building a RegExp (ReDoS / injection defence — the
  // seller originates from chain data, but never trust it as a regex source).
  const trimmed = String(sellerWallet).trim();
  if (!WALLET_REGEX.test(trimmed)) return [];
  const user = await User.findOne({
    walletAddress: { $regex: new RegExp(`^${escapeRegex(trimmed.slice(0, 42))}$`, 'i') },
  })
    .select('_id')
    .lean();
  if (!user) return [];
  return EnergyNode.find({ userId: user._id }).select('_id').lean();
}

/**
 * Fetch the highest anomaly score for the seller's nodes during the trade window.
 */
async function getAnomalyScore(nodeIds, from, to) {
  if (!nodeIds.length) return null;
  const docs = await AnomalyEvent.find({
    nodeId: { $in: nodeIds },
    timestamp: { $gte: from, $lte: to },
    dismissedAt: null,
    score: { $ne: null },
  })
    .sort({ score: -1 })
    .limit(1)
    .select('score')
    .lean();
  return docs.length ? docs[0].score : null;
}

/**
 * Reconcile a single Settlement record. Reads the linked Trade for the window
 * bounds; fetches meter readings; updates the record + emits socket events.
 *
 * @returns {Promise<object>} the updated settlement (lean).
 */
async function reconcileSettlement(settlement) {
  const trade = settlement.tradeRef
    ? await Trade.findById(settlement.tradeRef).lean()
    : await Trade.findOne({
        txHash: settlement.txHash,
        eventType: 'purchased',
      })
        .sort({ logIndex: 1 })
        .lean();

  const purchaseTime = trade?.blockTimestamp || settlement.updatedAt || new Date();

  // Resolve the listing window start from the on-chain listing struct.
  let windowStart = null;
  try {
    const contract = BlockchainService.getEnergyTradingContractReadOnly();
    const listing = await contract.listings(settlement.listingId);
    const createdAt = Number(listing.createdAt ?? listing[4] ?? 0);
    if (createdAt > 0) {
      windowStart = new Date(createdAt * 1000);
    }
  } catch (err) {
    logBackgroundError('reconciliation.listingWindow', err, {
      listingId: settlement.listingId,
    });
  }

  if (!windowStart) {
    // Best effort: fall back to a fixed lookback so we still attempt a reading.
    windowStart = new Date(purchaseTime.getTime() - 24 * MS_PER_HOUR);
  }

  const from = windowStart;
  const to = purchaseTime;

  // Seller's metered nodes.
  const nodes = await resolveSellerNodes(settlement.seller);
  const nodeIds = nodes.map((n) => n._id);

  const rawReadings = nodeIds.length
    ? await EnergyReading.find({
        nodeId: { $in: nodeIds },
        timestamp: { $gte: from, $lte: to },
        energyGenerated: { $gte: 0 },
      })
        .sort({ timestamp: 1 })
        .select('energyGenerated timestamp unit -_id')
        .lean()
    : [];

  const samples = rawReadings.map((r) => ({
    t: new Date(r.timestamp).getTime(),
    kw: Number(r.energyGenerated) || 0,
    unit: r.unit,
  }));

  const tolerancePct = getTolerancePct();
  const onChainEnergy = Number.isFinite(settlement.onChainEnergy)
    ? Number(settlement.onChainEnergy)
    : null;

  const evidence = {
    ...(settlement.evidence || {}),
    reconciliation: {
      window: { from: from.toISOString(), to: to.toISOString() },
      nodeCount: nodeIds.length,
      sampleCount: samples.length,
      runAt: new Date().toISOString(),
    },
  };

  const update = { lastReconciledAt: new Date() };
  const mismatchFlags = Array.isArray(settlement.mismatchFlags)
    ? settlement.mismatchFlags.filter((f) => f !== 'OVER_DELIVERY' && f !== 'UNDER_DELIVERY' && f !== 'READING_GAP')
    : [];

  if (samples.length === 0) {
    // No telemetry for the window — a data-integrity gap worth surfacing.
    mismatchFlags.push('READING_GAP');
    update.offChainEnergy = 0;
    update.deltaPct = null;
    update.mismatchFlags = mismatchFlags;
    if (settlement.verificationStatus === 'pending') {
      update.verificationStatus = 'mismatch';
    }
    update.evidence = evidence;
  } else {
    const offChainEnergy = integrateEnergyKwh(samples);
    update.offChainEnergy = offChainEnergy;
    evidence.reconciliation.offChainEnergyKwh = offChainEnergy;

    if (onChainEnergy != null && onChainEnergy > 0) {
      const deltaPct = ((offChainEnergy - onChainEnergy) / onChainEnergy) * 100;
      update.deltaPct = deltaPct;
      const exceeded = Math.abs(deltaPct) > tolerancePct;
      if (exceeded) {
        if (deltaPct > 0) mismatchFlags.push('OVER_DELIVERY');
        else mismatchFlags.push('UNDER_DELIVERY');
        if (settlement.verificationStatus === 'pending' || settlement.verificationStatus === 'verified') {
          update.verificationStatus = 'mismatch';
        }
      }
      evidence.reconciliation.deltaPct = deltaPct;
      evidence.reconciliation.tolerancePct = tolerancePct;
    }
    update.mismatchFlags = Array.from(new Set(mismatchFlags));
    update.evidence = evidence;
  }

  // 5.2.7 — AI anomaly tie-in. A mismatch combined with a high anomaly score
  // escalates the settlement to disputed automatically.
  const anomalyScore = await getAnomalyScore(nodeIds, from, to).catch(() => null);
  update.anomalyScore = anomalyScore;
  const isMismatch = (update.mismatchFlags || mismatchFlags).length > 0;
  const autoFlag = isMismatch
    && anomalyScore != null
    && anomalyScore >= getAutoFlagThreshold();
  if (autoFlag) {
    update.verificationStatus = 'disputed';
    update.autoFlagged = true;
  }

  const updated = await Settlement.findOneAndUpdate(
    { chainId: settlement.chainId, contractAddress: settlement.contractAddress, txHash: settlement.txHash, logIndex: settlement.logIndex },
    { $set: update },
    { new: true },
  ).lean();

  // Emit + audit only on a state transition to avoid noise on no-op ticks.
  emitSettlementEvent(updated, { wasMismatch: !isMismatchBefore(settlement) });

  auditService
    .log({
      actor: { _id: null, email: null, role: 'system' },
      action: isMismatch || autoFlag ? 'SETTLEMENT_MISMATCH' : 'SETTLEMENT_RECONCILED',
      resourceType: 'trade',
      resourceId: settlement.txHash,
      metadata: {
        listingId: settlement.listingId,
        onChainEnergy,
        offChainEnergy: update.offChainEnergy,
        deltaPct: update.deltaPct,
        mismatchFlags: update.mismatchFlags,
        anomalyScore,
        autoFlagged: autoFlag || undefined,
      },
      severity: isMismatch || autoFlag ? 'warn' : 'info',
    })
    .catch((e) => logBackgroundError('reconciliation.audit', e));

  return updated;
}

const isMismatchBefore = (settlement) =>
  Array.isArray(settlement.mismatchFlags) && settlement.mismatchFlags.length > 0;

function emitSettlementEvent(settlement, { wasMismatch } = {}) {
  if (!settlement) return;
  const payload = {
    settlementId: settlement._id,
    txHash: settlement.txHash,
    listingId: settlement.listingId,
    verificationStatus: settlement.verificationStatus,
    deltaPct: settlement.deltaPct,
    mismatchFlags: settlement.mismatchFlags,
  };
  const status = settlement.verificationStatus;
  const nowMismatch = status === 'mismatch' || status === 'disputed';
  if (status === 'verified') {
    socketBroadcastService.emitBlockchainEvent({ eventType: 'settlementVerified', ...payload });
  } else if (nowMismatch && wasMismatch === false) {
    socketBroadcastService.emitBlockchainEvent({ eventType: 'settlementMismatch', ...payload });
  } else if (nowMismatch) {
    socketBroadcastService.emitBlockchainEvent({ eventType: 'settlementMismatch', ...payload });
  }
}

/**
 * Reconcile all pending / mismatched settlements in bounded batches.
 * Idempotent: a re-run only recomputes records that are not terminal.
 *
 * @returns {Promise<{processed:number, mismatches:number, disputes:number}>}
 */
async function runReconciliation({ maxBatch } = {}) {
  const batch = Math.min(maxBatch || getReconcileBatchSize(), 500);
  const pending = await Settlement.find({
    verificationStatus: { $in: ['pending', 'mismatch'] },
    onChainEnergy: { $gt: 0 },
  })
    .sort({ createdAt: 1 })
    .limit(batch)
    .lean();

  let processed = 0;
  let mismatches = 0;
  let disputes = 0;

  for (const settlement of pending) {
    try {
      const updated = await reconcileSettlement(settlement);
      processed += 1;
      if (updated.verificationStatus === 'disputed') disputes += 1;
      if (updated.mismatchFlags && updated.mismatchFlags.length > 0) mismatches += 1;
    } catch (err) {
      logBackgroundError('reconciliation.settlement', err, {
        settlementId: settlement._id,
        txHash: settlement.txHash,
      });
    }
  }

  logger.info('reconciliation run complete', {
    processed,
    mismatches,
    disputes,
    component: 'reconciliation',
  });

  return { processed, mismatches, disputes };
}

/**
 * Backfill pending Settlement records for any purchased Trade that does not yet
 * have one. Idempotent upsert keyed by chain/contract/tx/logIndex. Called after
 * a sync tick so every purchase has a Settlement record (acceptance criterion).
 *
 * @returns {Promise<number>} number of settlements created.
 */
async function ensureSettlementsForPurchases() {
  const purchased = await Trade.find({ eventType: 'purchased' })
    .select('txHash logIndex blockNumber blockTimestamp chainId contractAddress listingId seller buyer energyAmount price')
    .lean();

  let created = 0;
  for (const t of purchased) {
    const filter = {
      chainId: t.chainId,
      contractAddress: (t.contractAddress || '').toLowerCase(),
      txHash: t.txHash,
      logIndex: t.logIndex,
    };
    const exists = await Settlement.countDocuments(filter).limit(1);
    if (exists) continue;

    await Settlement.updateOne(
      filter,
      {
        $setOnInsert: {
          ...filter,
          listingId: t.listingId,
          tradeRef: t._id,
          seller: t.seller,
          buyer: t.buyer,
          onChainEnergy: Number(t.energyAmount) || null,
          onChainPrice: t.price ?? null,
          onChainStatus: 'sold',
          verificationStatus: 'pending',
          blockNumber: t.blockNumber ?? null,
        },
      },
      { upsert: true },
    );
    created += 1;
  }
  return created;
}

module.exports = {
  runReconciliation,
  reconcileSettlement,
  ensureSettlementsForPurchases,
  integrateEnergyKwh,
  resolveSellerNodes,
  getTolerancePct,
  getAutoFlagThreshold,
};
