const mongoose = require('mongoose');
const EnergyNode = require('../../models/EnergyNode');
const { NodeSimulatorState } = require('./nodeState');
const { createRestTransport, createSocketTransport } = require('./transports');

/** Fallback profiles when DB has no nodes (socket-only dev). */
const MOCK_NODES = [
  { nodeId: 'mock-solar-01', name: 'Riverside Solar', nodeType: 'producer', sourceType: 'solar', status: 'active' },
  { nodeId: 'mock-wind-01', name: 'Coastal Wind', nodeType: 'producer', sourceType: 'wind', status: 'active' },
  { nodeId: 'mock-home-01', name: 'Oak Street Home', nodeType: 'consumer', sourceType: 'home', status: 'active' },
  { nodeId: 'mock-prosumer-01', name: 'Green Campus', nodeType: 'prosumer', sourceType: 'solar', status: 'active' },
  { nodeId: 'mock-industry-01', name: 'North Plant', nodeType: 'consumer', sourceType: 'industry', status: 'active' },
];

const parseConfig = (overrides = {}) => ({
  transport: overrides.transport || process.env.SIM_TRANSPORT || 'socket',
  intervalMs: parseInt(overrides.intervalMs || process.env.SIM_INTERVAL_MS || '5000', 10),
  jitterMs: parseInt(overrides.jitterMs || process.env.SIM_INTERVAL_JITTER_MS || '1500', 10),
  socketUrl: overrides.socketUrl || process.env.SOCKET_URL || 'http://localhost:5000',
  apiUrl: overrides.apiUrl || process.env.SIM_API_URL || `http://localhost:${process.env.PORT || 5000}`,
  useDbNodes: overrides.useDbNodes !== false && process.env.SIM_USE_DB_NODES !== 'false',
  tickAllNodes: overrides.tickAllNodes !== false && process.env.SIM_TICK_ALL_NODES !== 'false',
});

const jitteredDelay = (baseMs, jitterMs) => {
  const delta = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
  return Math.max(1000, baseMs + delta);
};

const formatLog = (node, reading) => {
  const label = node.name || String(reading.nodeId).slice(-8);
  const src = node.sourceType || '?';
  return `[${new Date().toISOString()}] ${label} (${src}) | +${reading.energyGenerated} kW / -${reading.energyConsumed} kW`;
};

class SimulatorRunner {
  constructor(config = {}) {
    this.config = parseConfig(config);
    this.states = new Map();
    this.timer = null;
    this.transport = null;
    this.running = false;
  }

  async loadNodes() {
    if (this.config.useDbNodes && mongoose.connection.readyState === 1) {
      try {
        const nodes = await EnergyNode.find({ status: { $ne: 'inactive' } }).lean();
        if (nodes.length > 0) return nodes;
        console.warn('[Simulator] No active nodes in DB — using built-in mock profiles.');
      } catch (err) {
        console.warn('[Simulator] Could not load nodes from DB:', err.message);
      }
    }
    return MOCK_NODES;
  }

  async initTransport() {
    if (this.config.transport === 'rest') {
      this.transport = createRestTransport(this.config.apiUrl);
      return;
    }
    this.transport = createSocketTransport(this.config.socketUrl);
    await this.transport.waitForConnect();
  }

  async start() {
    const nodes = await this.loadNodes();
    this.states = new Map(
      nodes.map((node) => [String(node._id || node.nodeId), new NodeSimulatorState(node)]),
    );

    await this.initTransport();

    console.log(`[Simulator] Transport: ${this.transport.name}`);
    console.log(`[Simulator] Nodes: ${nodes.length} | interval ~${this.config.intervalMs}ms ±${this.config.jitterMs}ms`);
    console.log('[Simulator] Press Ctrl+C to stop.\n');

    this.running = true;
    this.scheduleTick();
  }

  pickStatesForTick() {
    const all = Array.from(this.states.values());
    if (this.config.tickAllNodes || all.length <= 3) {
      return all;
    }
    const count = Math.max(1, Math.ceil(all.length * 0.6));
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  async tick() {
    const batch = this.pickStatesForTick();
    for (const state of batch) {
      const reading = state.nextReading();
      try {
        await this.transport.send(reading);
        console.log(formatLog(state.node, reading));
      } catch (err) {
        console.error(`[Simulator] Failed for ${state.key}:`, err.message);
      }
    }
  }

  scheduleTick() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.scheduleTick();
    }, jitteredDelay(this.config.intervalMs, this.config.jitterMs));
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.transport?.close) this.transport.close();
  }
}

module.exports = { SimulatorRunner, MOCK_NODES, parseConfig };
