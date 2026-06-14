const { computeTargets } = require('./profiles');
const configStore = require('./configStore');

const round2 = (n) => Math.round(n * 100) / 100;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Per-node smoother so readings evolve gradually instead of jumping each tick.
 * Also tracks active failure modes (with a per-tick countdown) so a configured
 * failure persists for `durationTicks` once it triggers.
 */
class NodeSimulatorState {
  constructor(node) {
    this.node = node;
    this.key = String(node._id || node.nodeId);
    this.smoothedGen = 0;
    this.smoothedCon = 0;
    this.smoothing = 0.32;
    /** @type {{ mode:string, remainingTicks:number, outputMultiplier:number }[]} */
    this.activeFailures = [];
  }

  // Failure modes from the live config that target this node.
  getApplicableFailureModes() {
    const config = configStore.get();
    const modes = config?.failureModes || [];
    return modes.filter((m) => {
      if (m.enabled === false) return false;
      if (m.target === 'source') {
        return !!m.sourceType && m.sourceType === this.node.sourceType;
      }
      // target === 'node'
      return m.nodeId && String(m.nodeId) === this.key;
    });
  }

  // Advance the active-failure state machine: expire finished failures and
  // roll the dice for newly triggered ones.
  rollFailures(applicableModes) {
    this.activeFailures = this.activeFailures.filter((f) => {
      f.remainingTicks -= 1;
      return f.remainingTicks > 0;
    });

    for (const m of applicableModes) {
      // Don't stack the same mode while one is already active.
      if (this.activeFailures.some((f) => f.mode === m.mode)) continue;
      if (Math.random() < clamp01(m.probability ?? 0)) {
        this.activeFailures.push({
          mode: m.mode,
          remainingTicks: Math.max(1, m.durationTicks || 1),
          outputMultiplier: m.outputMultiplier ?? 0,
        });
      }
    }
  }

  applyFailures(gen, con) {
    let energyGenerated = gen;
    let energyConsumed = con;
    for (const f of this.activeFailures) {
      if (f.mode === 'offline') {
        energyGenerated = 0;
        energyConsumed = energyConsumed * 0.15;
      } else if (f.mode === 'reduced_output') {
        energyGenerated *= clamp01(f.outputMultiplier ?? 0.3);
      } else if (f.mode === 'spike') {
        energyGenerated *= Math.max(0, f.outputMultiplier ?? 2.5);
      } else if (f.mode === 'intermittent') {
        if (Math.random() < 0.5) {
          energyGenerated *= clamp01(f.outputMultiplier ?? 0);
        }
      }
    }
    return { energyGenerated, energyConsumed };
  }

  nextReading(at = new Date()) {
    const capacityOverrides = configStore.getCapacityOverrides();

    const applicableModes = this.getApplicableFailureModes();
    this.rollFailures(applicableModes);

    let { energyGenerated, energyConsumed } = computeTargets(this.node, at, { capacityOverrides });
    const after = this.applyFailures(energyGenerated, energyConsumed);
    energyGenerated = after.energyGenerated;
    energyConsumed = after.energyConsumed;

    const alpha = this.smoothing;
    this.smoothedGen = this.smoothedGen * (1 - alpha) + energyGenerated * alpha;
    this.smoothedCon = this.smoothedCon * (1 - alpha) + energyConsumed * alpha;

    const genNoise = (Math.random() - 0.5) * Math.max(0.8, this.smoothedGen * 0.06);
    const conNoise = (Math.random() - 0.5) * Math.max(0.5, this.smoothedCon * 0.05);

    return {
      nodeId: this.node._id || this.node.nodeId,
      sourceType: this.node.sourceType,
      name: this.node.name,
      energyGenerated: round2(Math.max(0, this.smoothedGen + genNoise)),
      energyConsumed: round2(Math.max(0, this.smoothedCon + conNoise)),
      timestamp: at.toISOString(),
      ...(this.activeFailures.length > 0
        ? { failures: this.activeFailures.map((f) => f.mode) }
        : {}),
    };
  }
}

module.exports = { NodeSimulatorState };
