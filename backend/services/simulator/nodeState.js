const { computeTargets } = require('./profiles');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Per-node smoother so readings evolve gradually instead of jumping each tick.
 */
class NodeSimulatorState {
  constructor(node) {
    this.node = node;
    this.key = String(node._id || node.nodeId);
    this.smoothedGen = 0;
    this.smoothedCon = 0;
    this.smoothing = 0.32;
  }

  nextReading(at = new Date()) {
    const { energyGenerated, energyConsumed } = computeTargets(this.node, at);
    const alpha = this.smoothing;

    this.smoothedGen = this.smoothedGen * (1 - alpha) + energyGenerated * alpha;
    this.smoothedCon = this.smoothedCon * (1 - alpha) + energyConsumed * alpha;

    const genNoise = (Math.random() - 0.5) * Math.max(0.8, this.smoothedGen * 0.06);
    const conNoise = (Math.random() - 0.5) * Math.max(0.5, this.smoothedCon * 0.05);

    return {
      nodeId: this.node._id || this.node.nodeId,
      energyGenerated: round2(Math.max(0, this.smoothedGen + genNoise)),
      energyConsumed: round2(Math.max(0, this.smoothedCon + conNoise)),
      timestamp: at.toISOString(),
    };
  }
}

module.exports = { NodeSimulatorState };
