/**
 * Energy / carbon flow aggregation — Module 9.1.
 *
 * Produces a Sankey-ready graph of who exported/imported energy (kWh) and the
 * matching carbon-credit movement (CC) between wallets.
 *
 * Sources:
 *   - Trade        : direction + volume of marketplace purchases (primary).
 *   - Settlement   : on-chain-verified energy subset (gates "delivered" kWh).
 *   - EnergyReading: net generation for the caller's own nodes (summary only).
 *
 * Security notes:
 *   - All user-supplied inputs are validated by `parseWindow` / `normalizeWallet`
 *     before reaching Mongo. No raw query string is ever interpolated into a
 *     pipeline stage, so there is no `$`-operator / NoSQL injection surface.
 *   - Output size is bounded by MAX_NODES / MAX_LINKS to keep payloads and
 *     render cost predictable (DoS guardrail).
 */
const Trade = require('../../models/Trade');
const Settlement = require('../../models/Settlement');
const EnergyNode = require('../../models/EnergyNode');
const EnergyReading = require('../../models/EnergyReading');

const WINDOW_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
const ALLOWED_WINDOWS = Object.keys(WINDOW_MS);
const DEFAULT_WINDOW = '7d';

const MAX_NODES = clampInt(process.env.ENERGY_FLOW_MAX_NODES, 40, 1, 200);
const MAX_LINKS = clampInt(process.env.ENERGY_FLOW_MAX_LINKS, 200, 1, 1000);
const MAX_GENERATION_NODES = clampInt(process.env.ENERGY_FLOW_MAX_GEN_NODES, 50, 1, 500);

const ETH_ADDRESS_RE = /^0x[a-f0-9]{40}$/i;

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const shortAddr = (addr) => {
  const a = String(addr || '');
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
};

const flowError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

/**
 * Validate the `window` query param. Throws 400 on anything outside the allow-list.
 */
const parseWindow = (raw) => {
  const w = String(raw ?? '').trim();
  if (!w) return DEFAULT_WINDOW;
  if (!ALLOWED_WINDOWS.includes(w)) {
    throw flowError(`window must be one of: ${ALLOWED_WINDOWS.join(', ')}`);
  }
  return w;
};

/**
 * Normalize + validate a wallet address. Returns lowercase 0x-address or null.
 * Throws 400 on malformed input (non-null).
 */
const normalizeWallet = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const w = String(raw).trim().toLowerCase();
  if (!ETH_ADDRESS_RE.test(w)) {
    throw flowError('Invalid wallet address');
  }
  return w;
};

const windowToSince = (window) => {
  const ms = WINDOW_MS[window];
  return ms ? new Date(Date.now() - ms) : null;
};

/**
 * Resolve the wallet scope for a request.
 *
 * Privileged users (admin/moderator) may view global flow, or optionally a
 * specific wallet. Everyone else is locked to their own linked wallet: a
 * missing wallet yields 400, a cross-wallet request yields 403.
 */
const resolveFlowScope = (user, query = {}) => {
  const privileged = user?.role === 'admin' || user?.role === 'moderator';
  const requested = normalizeWallet(query.wallet);

  if (privileged) {
    return {
      scope: 'global',
      wallet: requested || null,
      privileged: true,
      userId: user?._id ? String(user._id) : null,
    };
  }

  const own = user?.walletAddress ? String(user.walletAddress).trim().toLowerCase() : null;
  if (!own || !ETH_ADDRESS_RE.test(own)) {
    throw flowError('Link a wallet address to your account to view energy flow', 400);
  }
  if (requested && requested !== own) {
    throw flowError('You can only view energy flow for your own wallet', 403);
  }
  return {
    scope: 'wallet',
    wallet: own,
    privileged: false,
    userId: user?._id ? String(user._id) : null,
  };
};

/**
 * Merge raw trade legs into directed pairs and emit kWh + CC links.
 *
 * `tradeLegs`  : [{ seller, buyer, energyKwh, carbonCc, trades }]
 * `verifiedMap`: Map(`${seller}>${buyer}` -> verifiedEnergyKwh)
 *
 * Pure — safe to unit test without a database.
 */
const buildFlowGraph = ({ tradeLegs = [], verifiedMap = new Map(), opts = {} }) => {
  const maxNodes = opts.maxNodes || MAX_NODES;
  const maxLinks = opts.maxLinks || MAX_LINKS;

  const acc = new Map();
  for (const leg of tradeLegs) {
    const s = String(leg.seller || '').toLowerCase();
    const b = String(leg.buyer || '').toLowerCase();
    if (!s || !b || s === b) continue;
    const key = `${s}>${b}`;
    const cur =
      acc.get(key) ||
      { seller: s, buyer: b, energyKwh: 0, carbonCc: 0, trades: 0, verifiedEnergyKwh: 0 };
    cur.energyKwh += Number(leg.energyKwh) || 0;
    cur.carbonCc += Number(leg.carbonCc) || 0;
    cur.trades += Number(leg.trades) || 1;
    cur.verifiedEnergyKwh = Number(verifiedMap.get(key) || 0);
    acc.set(key, cur);
  }

  const energyLinks = [];
  const carbonLinks = [];
  for (const v of acc.values()) {
    const energy = round(v.energyKwh);
    const carbon = round(v.carbonCc);
    const verified = round(Math.min(v.verifiedEnergyKwh, v.energyKwh));
    if (energy > 0) {
      energyLinks.push({
        source: v.seller,
        target: v.buyer,
        value: energy,
        unit: 'kWh',
        trades: v.trades,
        verifiedEnergyKwh: verified,
      });
    }
    if (carbon > 0) {
      carbonLinks.push({
        source: v.seller,
        target: v.buyer,
        value: carbon,
        unit: 'CC',
        trades: v.trades,
      });
    }
  }

  // Cap links first (by value), then derive the surviving node set.
  const allLinks = [...energyLinks, ...carbonLinks]
    .sort((a, b) => b.value - a.value)
    .slice(0, maxLinks);

  // Per-node flow totals + direction → layer + type.
  const nodeStats = new Map();
  const bump = (id, dir, value) => {
    if (!nodeStats.has(id)) nodeStats.set(id, { out: 0, in: 0 });
    nodeStats.get(id)[dir] += value;
  };
  for (const link of allLinks) {
    bump(link.source, 'out', link.value);
    bump(link.target, 'in', link.value);
  }

  // Rank nodes by total flow and cap to MAX_NODES.
  const rankedNodes = [...nodeStats.entries()]
    .map(([id, st]) => ({ id, total: st.out + st.in }))
    .sort((a, b) => b.total - a.total)
    .slice(0, maxNodes)
    .map((n) => n.id);
  const keep = new Set(rankedNodes);

  const links = allLinks.filter((l) => keep.has(l.source) && keep.has(l.target));

  const nodes = rankedNodes.map((id) => {
    const st = nodeStats.get(id);
    const isSource = st.in === 0 && st.out > 0;
    const isSink = st.out === 0 && st.in > 0;
    let type = 'prosumer';
    if (isSource) type = 'producer';
    else if (isSink) type = 'consumer';
    // layer: 0 = net exporter (left), 1 = hub, 2 = net importer (right)
    const layer = isSource ? 0 : isSink ? 2 : 1;
    return {
      id,
      name: shortAddr(id),
      type,
      layer,
      outValue: round(st.out),
      inValue: round(st.in),
    };
  });

  const totalEnergyKwh = round(
    links.filter((l) => l.unit === 'kWh').reduce((s, l) => s + l.value, 0),
  );
  const totalCarbonCc = round(
    links.filter((l) => l.unit === 'CC').reduce((s, l) => s + l.value, 0),
  );
  const verifiedEnergyKwh = round(
    links.filter((l) => l.unit === 'kWh').reduce((s, l) => s + (l.verifiedEnergyKwh || 0), 0),
  );
  const tradeCount = (acc.size > 0
    ? [...acc.values()].reduce((s, v) => s + v.trades, 0)
    : 0);

  return {
    nodes,
    links,
    summary: {
      totalEnergyKwh,
      totalCarbonCc,
      verifiedEnergyKwh,
      tradeCount,
      nodeCount: nodes.length,
      linkCount: links.length,
    },
  };
};

const keyPair = (seller, buyer) => `${String(seller).toLowerCase()}>${String(buyer).toLowerCase()}`;

/**
 * Fetch trade legs in scope for the window.
 */
const fetchTradeLegs = async ({ wallet, since }) => {
  const match = {
    eventType: 'purchased',
    seller: { $nin: [null, ''] },
    buyer: { $nin: [null, ''] },
    energyAmount: { $gt: 0 },
  };
  if (since) match.blockTimestamp = { $gte: since };
  if (wallet) match.$or = [{ seller: wallet }, { buyer: wallet }];

  const rows = await Trade.aggregate([
    { $match: match },
    {
      $group: {
        _id: { s: '$seller', b: '$buyer' },
        energyKwh: { $sum: '$energyAmount' },
        carbonCc: { $sum: { $toDouble: '$price' } },
        trades: { $sum: 1 },
      },
    },
  ]);

  return rows.map((r) => ({
    seller: String(r._id.s).toLowerCase(),
    buyer: String(r._id.b).toLowerCase(),
    energyKwh: r.energyKwh || 0,
    carbonCc: r.carbonCc || 0,
    trades: r.trades || 0,
  }));
};

/**
 * On-chain-verified energy per (seller,buyer) in scope.
 */
const fetchVerifiedMap = async ({ wallet, since }) => {
  const match = {
    verificationStatus: 'verified',
    seller: { $nin: [null, ''] },
    buyer: { $nin: [null, ''] },
    onChainEnergy: { $gt: 0 },
  };
  if (since) match.createdAt = { $gte: since };
  if (wallet) match.$or = [{ seller: wallet }, { buyer: wallet }];

  const rows = await Settlement.aggregate([
    { $match: match },
    {
      $group: {
        _id: { s: '$seller', b: '$buyer' },
        verified: { $sum: '$onChainEnergy' },
      },
    },
  ]);

  const map = new Map();
  for (const r of rows) {
    map.set(keyPair(r._id.s, r._id.b), r.verified || 0);
  }
  return map;
};

/**
 * Net generation for the caller's own producer/prosumer nodes (scoped view
 * only). Summed readings are an indicator, not strict kWh metering — surfaced
 * as summary context rather than a Sankey link to avoid misrepresentation.
 */
const fetchScopedNetGeneration = async ({ userId, since }) => {
  if (!userId) return { netGenerationKwh: 0, generationNodeCount: 0 };

  const nodes = await EnergyNode.find({ userId, status: 'active' })
    .select('_id nodeType')
    .limit(MAX_GENERATION_NODES + 1)
    .lean();
  const producerIds = nodes
    .filter((n) => n.nodeType === 'producer' || n.nodeType === 'prosumer')
    .map((n) => n._id);
  if (producerIds.length === 0) return { netGenerationKwh: 0, generationNodeCount: 0 };

  const match = { nodeId: { $in: producerIds } };
  if (since) match.timestamp = { $gte: since };

  const rows = await EnergyReading.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        generated: { $sum: '$energyGenerated' },
        consumed: { $sum: '$energyConsumed' },
      },
    },
  ]);

  const totals = rows[0] || {};
  const net = round((totals.generated || 0) - (totals.consumed || 0));
  return {
    netGenerationKwh: net > 0 ? net : 0,
    generationNodeCount: producerIds.length,
  };
};

/**
 * Top-level entry: build the energy-flow graph for a request scope.
 */
const getEnergyFlow = async ({ window: windowRaw, user, query = {} }) => {
  const window = parseWindow(windowRaw);
  const since = windowToSince(window);
  const scope = resolveFlowScope(user, query);

  const [tradeLegs, verifiedMap] = await Promise.all([
    fetchTradeLegs({ wallet: scope.wallet, since }),
    fetchVerifiedMap({ wallet: scope.wallet, since }),
  ]);

  const graph = buildFlowGraph({ tradeLegs, verifiedMap });

  // EnergyReading context — only meaningful for the caller's own nodes.
  let generation = { netGenerationKwh: 0, generationNodeCount: 0 };
  if (!scope.privileged && scope.userId) {
    generation = await fetchScopedNetGeneration({ userId: scope.userId, since });
  }

  return {
    window,
    from: since ? since.toISOString() : null,
    to: new Date().toISOString(),
    scope: scope.scope,
    wallet: scope.wallet,
    summary: { ...graph.summary, ...generation },
    nodes: graph.nodes,
    links: graph.links,
  };
};

module.exports = {
  // public
  getEnergyFlow,
  buildFlowGraph,
  parseWindow,
  normalizeWallet,
  resolveFlowScope,
  // exported for tests / reuse
  ALLOWED_WINDOWS,
  DEFAULT_WINDOW,
  ETH_ADDRESS_RE,
  keyPair,
  round,
  shortAddr,
};
