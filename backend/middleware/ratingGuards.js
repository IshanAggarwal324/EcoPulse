const { validateRatingInput } = require('../services/reputationService');

const validateRatingBody = (req, res, next) => {
  const rater = req.user?.walletAddress;
  const result = validateRatingInput({
    rater,
    ratedWallet: req.body?.ratedWallet,
    listingId: req.body?.listingId,
    tradeTxHash: req.body?.tradeTxHash,
    score: req.body?.score,
    comment: req.body?.comment,
  });
  if (!result.ok) {
    return res.status(400).json({
      success: false,
      message: 'Invalid rating submission',
      errors: result.errors,
    });
  }
  req.rating = result.value;
  next();
};

module.exports = { validateRatingBody };
