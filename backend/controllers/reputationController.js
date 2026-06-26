const asyncHandler = require('../utils/asyncHandler');
const reputationService = require('../services/reputationService');
const { validateWalletAddress } = require('../utils/validators');

const submitRating = asyncHandler(async (req, res) => {
  try {
    const rating = await reputationService.submitRating(req.rating, { actor: req.user });
    return res.status(201).json({ success: true, data: rating });
  } catch (err) {
    if (err && err.code && err.status) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    }
    throw err;
  }
});

const listRatings = asyncHandler(async (req, res) => {
  const rawListingId = req.query.listingId;
  const listingId = rawListingId != null && rawListingId !== '' ? parseInt(rawListingId, 10) : null;
  const ratedWallet = req.query.sellerWallet || req.query.ratedWallet || null;

  if (ratedWallet) {
    const walletError = validateWalletAddress(ratedWallet, { required: true });
    if (walletError) {
      return res.status(400).json({ success: false, message: walletError });
    }
  }

  const data = await reputationService.listRatings({
    listingId: Number.isInteger(listingId) ? listingId : null,
    ratedWallet: ratedWallet ? String(ratedWallet).toLowerCase() : null,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.status(200).json({ success: true, data });
});

const getReputationByWallet = asyncHandler(async (req, res) => {
  const walletError = validateWalletAddress(req.params.wallet, { required: true });
  if (walletError) {
    return res.status(400).json({ success: false, message: walletError });
  }
  try {
    const rep = await reputationService.getReputation(req.params.wallet);
    return res.status(200).json({ success: true, data: rep });
  } catch (err) {
    if (err && err.code === 'INVALID_WALLET') {
      return res.status(400).json({ success: false, message: err.message });
    }
    throw err;
  }
});

const getNodeReputation = asyncHandler(async (req, res) => {
  try {
    const rep = await reputationService.getNodeReputation(req.params.nodeId);
    return res.status(200).json({ success: true, data: rep });
  } catch (err) {
    if (err && err.code === 'INVALID_NODE_ID') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err && err.code === 'NODE_NOT_FOUND') {
      return res.status(404).json({ success: false, message: err.message });
    }
    throw err;
  }
});

module.exports = {
  submitRating,
  listRatings,
  getReputationByWallet,
  getNodeReputation,
};
