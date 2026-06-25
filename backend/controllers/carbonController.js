const { ethers } = require('ethers');
const asyncHandler = require('../utils/asyncHandler');
const BlockchainService = require('../services/blockchainService');
const retirementService = require('../services/retirementService');
const bridgeService = require('../services/bridgeService');
const mintEligibilityService = require('../services/mintEligibilityService');

const isPrivileged = (user) => user?.role === 'admin' || user?.role === 'moderator';
const TX_HASH_RE = /^0x[a-f0-9]{64}$/i;

const resolveWalletScope = (req, { allowGlobal = false } = {}) => {
  const requested = req.query.wallet ? String(req.query.wallet).toLowerCase() : null;
  if (isPrivileged(req.user)) {
    return requested || (allowGlobal ? null : req.user?.walletAddress?.toLowerCase() || null);
  }
  const own = req.user?.walletAddress ? String(req.user.walletAddress).toLowerCase() : null;
  if (!own) {
    const err = new Error('Wallet address is required for this account');
    err.statusCode = 400;
    throw err;
  }
  if (requested && requested !== own) {
    const err = new Error('You can only access your own carbon data');
    err.statusCode = 403;
    throw err;
  }
  return own;
};

/**
 * POST /api/v1/carbon/retirements
 * Body: { txHash }. Indexes a client-signed retirement tx receipt. The caller's
 * wallet must appear as the retiree (admins exempt) — the backend never signs
 * burns on behalf of users.
 */
const indexRetirement = asyncHandler(async (req, res) => {
  const txHash = String(req.body?.txHash || '').toLowerCase();
  if (!TX_HASH_RE.test(txHash)) {
    return res.status(400).json({ success: false, message: 'Invalid txHash' });
  }

  const records = await retirementService.indexRetirementTx(txHash, {
    actor: { id: req.user?.id, email: req.user?.email, role: req.user?.role },
  });

  if (records.length === 0) {
    return res.status(404).json({ success: false, message: 'No retirement events found in this transaction' });
  }

  const own = req.user?.walletAddress?.toLowerCase();
  if (!isPrivileged(req.user) && own) {
    const seenForeign = records.some((r) => r.retiree !== own);
    if (seenForeign) {
      return res.status(403).json({ success: false, message: 'Not authorized to index retirements for other wallets' });
    }
  }

  res.status(200).json({ success: true, data: records });
});

/**
 * GET /api/v1/carbon/retirements
 */
const listRetirements = asyncHandler(async (req, res) => {
  const wallet = resolveWalletScope(req, { allowGlobal: isPrivileged(req.user) });
  const result = await retirementService.getRetirements({
    wallet,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ success: true, data: result.data, meta: result.meta });
});

/**
 * GET /api/v1/carbon/balance — caller's balance + retirement totals.
 */
const getBalance = asyncHandler(async (req, res) => {
  const wallet = resolveWalletScope(req);
  const [balance, totals] = await Promise.all([
    BlockchainService.getBalance(wallet).catch(() => null),
    retirementService.getTotals(),
  ]);
  res.status(200).json({ success: true, data: { wallet, balance, ...totals } });
});

/**
 * GET /api/v1/carbon/totals — platform-wide supply / retired totals.
 */
const getTotals = asyncHandler(async (req, res) => {
  const totals = await retirementService.getTotals();
  res.status(200).json({ success: true, data: totals });
});

/**
 * POST /api/v1/carbon/bridge/index — index a client-signed bridge tx receipt.
 */
const indexBridgeTransfer = asyncHandler(async (req, res) => {
  const txHash = String(req.body?.txHash || '').toLowerCase();
  if (!TX_HASH_RE.test(txHash)) {
    return res.status(400).json({ success: false, message: 'Invalid txHash' });
  }

  const records = await bridgeService.indexBridgeTx(txHash);

  if (records.length === 0) {
    return res.status(404).json({ success: false, message: 'No bridge events found in this transaction' });
  }

  const own = req.user?.walletAddress?.toLowerCase();
  if (!isPrivileged(req.user) && own) {
    const seenForeign = records.some((r) => {
      const parties = [r.sender, r.recipient].filter(Boolean).map((a) => String(a).toLowerCase());
      return !parties.includes(own);
    });
    if (seenForeign) {
      return res.status(403).json({ success: false, message: 'Not authorized to index bridge transfers for other wallets' });
    }
  }

  res.status(200).json({ success: true, data: records });
});

/**
 * GET /api/v1/carbon/bridge/transfers
 */
const listBridgeTransfers = asyncHandler(async (req, res) => {
  const wallet = resolveWalletScope(req, { allowGlobal: isPrivileged(req.user) });
  const result = await bridgeService.listBridgeTransfers({
    wallet,
    direction: req.query.direction,
    sourceChainId: req.query.sourceChainId,
    targetChainId: req.query.targetChainId,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ success: true, data: result.data, meta: result.meta });
});

/**
 * POST /api/v1/carbon/award — mint-to-earn (admin/system only). Awards CC for a
 * verified generation window under eligibility + idempotency rules.
 */
const awardCredits = asyncHandler(async (req, res) => {
  const { recipient, nodeId, kwh, windowStart, windowEnd, evidence } = req.body || {};
  if (!recipient || !ethers.isAddress(recipient)) {
    return res.status(400).json({ success: false, message: 'Invalid recipient address' });
  }
  if (!Number.isFinite(Number(kwh)) || Number(kwh) <= 0) {
    return res.status(400).json({ success: false, message: 'kWh must be a positive number' });
  }

  const result = await mintEligibilityService.awardCredits({
    recipient,
    nodeId,
    kwh: Number(kwh),
    windowStart,
    windowEnd,
    evidence,
    actor: { id: req.user?.id, email: req.user?.email, role: req.user?.role },
  });

  res.status(result.replay ? 200 : 201).json({
    success: true,
    replay: result.replay,
    data: result.record,
  });
});

module.exports = {
  indexRetirement,
  listRetirements,
  getBalance,
  getTotals,
  indexBridgeTransfer,
  listBridgeTransfers,
  awardCredits,
};
