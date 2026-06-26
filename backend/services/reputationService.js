const mongoose = require('mongoose');
const Settlement = require('../models/Settlement');
const Rating = require('../models/Rating');
const Reputation = require('../models/Reputation');
const { escapeRegex } = require('../utils/validators');

const MAX_COMMENT_LENGTH = 500;
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

const maskWallet = (wallet) => {
  const w = normalizeWallet(wallet);
  if (!WALLET_REGEX.test(w)) return null;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
};

const httpError = (status, code, message) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
};

const normalizeWallet = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const normalizeTxHash = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isIntegerScore = (value) => {
  if (typeof value === 'boolean') return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5;
};

const sanitizeComment = (raw) => {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/[<>]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_COMMENT_LENGTH) s = s.slice(0, MAX_COMMENT_LENGTH);
  return s;
};

const validateRatingInput = (input) => {
  const errors = [];
  const rater = normalizeWallet(input?.rater);
  const ratedWallet = normalizeWallet(input?.ratedWallet);
  const tradeTxHash = normalizeTxHash(input?.tradeTxHash);

  if (!WALLET_REGEX.test(rater)) errors.push('Invalid rater wallet address');
  if (!WALLET_REGEX.test(ratedWallet)) errors.push('Invalid rated wallet address');
  if (!TX_HASH_REGEX.test(tradeTxHash)) errors.push('Invalid trade transaction hash');
  if (!isIntegerScore(input?.score)) errors.push('Score must be an integer between 1 and 5');

  const listingId = Number(input?.listingId);
  if (!Number.isInteger(listingId) || listingId < 0) {
    errors.push('Invalid listing id');
  }

  if (rater && ratedWallet && rater === ratedWallet) {
    errors.push('You cannot rate your own wallet');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      rater,
      ratedWallet,
      listingId,
      tradeTxHash,
      score: Number(input.score),
      comment: sanitizeComment(input.comment),
    },
  };
};

const computeReputationFromRatings = (ratings) => {
  const list = Array.isArray(ratings) ? ratings : [];
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  for (const r of list) {
    const score = Number(r?.score);
    if (Number.isInteger(score) && score >= 1 && score <= 5) {
      sum += score;
      distribution[String(score)] += 1;
    }
  }
  const count = list.length;
  return {
    avgScore: count > 0 ? Math.round((sum / count) * 1e4) / 1e4 : 0,
    ratingCount: count,
    ratingSum: sum,
    scoreDistribution: distribution,
  };
};

const canRate = async (value, deps) => {
  const finders = deps || {};
  const settlement = await finders.findVerifiedSettlement({
    rater: value.rater,
    ratedWallet: value.ratedWallet,
    listingId: value.listingId,
    tradeTxHash: value.tradeTxHash,
  });
  if (!settlement) {
    return {
      allowed: false,
      code: 'NOT_VERIFIED_TRADE',
      reason: 'No verified trade found between these parties for this transaction',
    };
  }
  const existing = await finders.findExistingRating({
    rater: value.rater,
    tradeTxHash: value.tradeTxHash,
  });
  if (existing) {
    return {
      allowed: false,
      code: 'ALREADY_RATED',
      reason: 'You have already rated this trade',
    };
  }
  return { allowed: true, settlement };
};

const buildDefaultFinders = () => ({
  findVerifiedSettlement: async ({ rater, ratedWallet, listingId, tradeTxHash }) =>
    Settlement.findOne({
      txHash: tradeTxHash,
      listingId,
      buyer: rater,
      seller: ratedWallet,
      verificationStatus: 'verified',
    }).lean(),
  findExistingRating: async ({ rater, tradeTxHash }) =>
    Rating.findOne({ raterWallet: rater, tradeTxHash }).lean(),
});

const resolveSellerNodeId = async (wallet) => {
  try {
    const User = require('../models/User');
    const EnergyNode = require('../models/EnergyNode');
    const owner = await User.findOne({
      walletAddress: { $regex: new RegExp(`^${escapeRegex(wallet)}$`, 'i') },
    })
      .select('_id')
      .lean();
    if (!owner) return null;
    const nodes = await EnergyNode.find({ userId: owner._id })
      .select('_id')
      .lean();
    if (nodes.length === 1) return nodes[0]._id;
    return null;
  } catch {
    return null;
  }
};

const submitRating = async (input, opts = {}) => {
  const result = validateRatingInput(input);
  if (!result.ok) throw httpError(400, 'INVALID_INPUT', result.errors.join('; '));

  const value = result.value;
  const finders = opts.finders || buildDefaultFinders();

  const gate = await canRate(value, finders);
  if (!gate.allowed) {
    throw httpError(gate.code === 'ALREADY_RATED' ? 409 : 403, gate.code, gate.reason);
  }

  const createRating =
    opts.createRating ||
    ((doc) => Rating.create(doc).then((d) => d.toObject()));

  let ratingDoc;
  try {
    ratingDoc = await createRating({
      raterWallet: value.rater,
      ratedWallet: value.ratedWallet,
      listingId: value.listingId,
      tradeTxHash: value.tradeTxHash,
      score: value.score,
      comment: value.comment,
      chainId: gate.settlement.chainId ?? null,
      nodeId: opts.nodeId !== undefined ? opts.nodeId : await resolveSellerNodeId(value.ratedWallet),
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.name === 'DuplicateKeyError')) {
      throw httpError(409, 'ALREADY_RATED', 'You have already rated this trade');
    }
    throw err;
  }

  const recompute = opts.recompute || recomputeReputation;
  await recompute(value.ratedWallet).catch(() => {});

  return ratingDoc;
};

const recomputeReputation = async (wallet) => {
  const w = normalizeWallet(wallet);
  if (!WALLET_REGEX.test(w)) throw httpError(400, 'INVALID_WALLET', 'Invalid wallet address');

  const [ratings, settlements] = await Promise.all([
    Rating.find({ ratedWallet: w }).lean(),
    Settlement.find({ seller: w }).lean(),
  ]);

  const ratingAgg = computeReputationFromRatings(ratings);
  const total = settlements.length;
  const verified = settlements.filter((s) => s.verificationStatus === 'verified').length;
  const disputed = settlements.filter((s) => s.verificationStatus === 'disputed').length;

  const update = {
    avgScore: ratingAgg.avgScore,
    ratingCount: ratingAgg.ratingCount,
    ratingSum: ratingAgg.ratingSum,
    scoreDistribution: ratingAgg.scoreDistribution,
    completedTrades: verified,
    disputedTrades: disputed,
    verifiedDeliveries: verified,
    totalSettlements: total,
    disputeRate: total > 0 ? disputed / total : 0,
    verifiedDeliveryRate: total > 0 ? verified / total : 0,
    lastRatingAt:
      ratings.length > 0 ? ratings[ratings.length - 1].createdAt || null : null,
  };

  const rep = await Reputation.findOneAndUpdate({ wallet: w }, { $set: update }, {
    upsert: true,
    new: true,
  }).lean();
  return rep;
};

const getReputation = async (wallet) => {
  const w = normalizeWallet(wallet);
  if (!WALLET_REGEX.test(w)) throw httpError(400, 'INVALID_WALLET', 'Invalid wallet address');
  return recomputeReputation(w);
};

const resolveNodeOwnerWallet = async (nodeId) => {
  const EnergyNode = require('../models/EnergyNode');
  const User = require('../models/User');
  const node = await EnergyNode.findById(nodeId).select('userId name').lean();
  if (!node) return null;
  const owner = await User.findById(node.userId).select('walletAddress').lean();
  return { node, wallet: owner?.walletAddress ? owner.walletAddress.toLowerCase() : null };
};

const getNodeReputation = async (nodeId) => {
  if (!mongoose.Types.ObjectId.isValid(String(nodeId))) {
    throw httpError(400, 'INVALID_NODE_ID', 'Invalid node id');
  }
  const resolved = await resolveNodeOwnerWallet(nodeId);
  if (!resolved) throw httpError(404, 'NODE_NOT_FOUND', 'Node not found');

  const wallet = resolved.wallet;
  const ratings = wallet
    ? await Rating.find({ ratedWallet: wallet }).sort({ createdAt: -1 }).limit(50).lean()
    : [];
  const agg = computeReputationFromRatings(ratings);
  return {
    nodeId,
    nodeName: resolved.node.name,
    wallet,
    ...agg,
    recentReviews: ratings.slice(0, 5).map((r) => ({
      score: r.score,
      comment: r.comment,
      createdAt: r.createdAt,
      listingId: r.listingId,
    })),
  };
};

const listRatings = async ({ listingId = null, ratedWallet = null, raterWallet = null, page = 1, limit = 20 } = {}) => {
  const query = {};
  if (Number.isInteger(listingId)) query.listingId = listingId;
  if (ratedWallet) query.ratedWallet = normalizeWallet(ratedWallet);
  if (raterWallet) query.raterWallet = normalizeWallet(raterWallet);

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    Rating.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    Rating.countDocuments(query),
  ]);

  const ratings = items.map((item) => ({
    ...item,
    raterWallet: maskWallet(item.raterWallet),
  }));

  return {
    ratings,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
};

const DEFAULT_REPUTATION_SNAPSHOT = Object.freeze({
  avgScore: 0,
  ratingCount: 0,
  verifiedDeliveryRate: 0,
  disputeRate: 0,
  completedTrades: 0,
});

const attachReputationSnapshots = async (orders) => {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length === 0) return list;
  const wallets = [
    ...new Set(
      list
        .map((o) => (typeof o?.seller === 'string' ? o.seller.toLowerCase() : null))
        .filter(Boolean),
    ),
  ];
  if (wallets.length === 0) return list;

  const reps = await Reputation.find({ wallet: { $in: wallets } })
    .select('wallet avgScore ratingCount verifiedDeliveryRate disputeRate completedTrades')
    .lean();
  const byWallet = new Map(reps.map((r) => [r.wallet, r]));

  return list.map((order) => {
    if (!order || typeof order.seller !== 'string') return order;
    const rep = byWallet.get(order.seller.toLowerCase());
    return { ...order, reputation: rep ? {
      avgScore: rep.avgScore,
      ratingCount: rep.ratingCount,
      verifiedDeliveryRate: rep.verifiedDeliveryRate,
      disputeRate: rep.disputeRate,
      completedTrades: rep.completedTrades,
    } : { ...DEFAULT_REPUTATION_SNAPSHOT } };
  });
};

module.exports = {
  MAX_COMMENT_LENGTH,
  WALLET_REGEX,
  TX_HASH_REGEX,
  normalizeWallet,
  sanitizeComment,
  isIntegerScore,
  validateRatingInput,
  computeReputationFromRatings,
  canRate,
  buildDefaultFinders,
  submitRating,
  recomputeReputation,
  getReputation,
  getNodeReputation,
  listRatings,
  attachReputationSnapshots,
  httpError,
  DEFAULT_REPUTATION_SNAPSHOT,
};
