const express = require('express');
const {
  getOrders,
  getOrderById,
  getOrderBook,
  getOrderBookDepth,
  getBuyOrders,
  createBuyOrder,
  cancelBuyOrder,
} = require('../controllers/marketplaceController');
const { protect } = require('../middleware/auth');
const { createBuyOrderRateLimiter, createRatingRateLimiter } = require('../middleware/rateLimit');
const { validateRatingBody } = require('../middleware/ratingGuards');
const {
  submitRating,
  listRatings,
  getReputationByWallet,
  getNodeReputation,
} = require('../controllers/reputationController');
const {
  getMarketplaceTrades,
  getMarketTape,
  getAggregatedTrades,
  getMarketplaceTradeByTxHash,
  getExpiredListings,
} = require('../controllers/marketplaceTradeHistoryController');

const router = express.Router();

// Order book (Sub-module 6.1.1 / 6.1.2) — read side. Auth + api rate limit are
// applied at the v1 mount; these are hot read endpoints served from the cached
// active-listings snapshot.
router.get('/orderbook', protect, getOrderBook);
router.get('/orderbook/depth', protect, getOrderBookDepth);

// Buy-side signed intents (Sub-module 6.1.3) — demand side of the book. Writes
// carry an EIP-712 signature and a dedicated, tighter rate limit.
router.get('/orderbook/buy-orders', protect, getBuyOrders);
router.post('/orderbook/buy-orders', protect, createBuyOrderRateLimiter(), createBuyOrder);
router.delete('/orderbook/buy-orders/:id', protect, cancelBuyOrder);

// Existing sell-listing endpoints.
router.get('/orders', protect, getOrders);
router.get('/orders/:listingId', protect, getOrderById);

// Trade history (Module 6.2) — marketplace-native trade surface over the shared
// trade history service. Static segments are registered before the :txHash param
// route so they are not shadowed.
router.get('/trades', protect, getMarketplaceTrades);
router.get('/trades/recent', protect, getMarketTape);
router.get('/trades/aggregate', protect, getAggregatedTrades);
router.get('/trades/:txHash', protect, getMarketplaceTradeByTxHash);
router.get('/listings/expired', protect, getExpiredListings);

// Ratings & reputation (Module 6.3). Reputation reads are public-ish aggregate
// views behind `protect`; rating writes carry a tighter rate limit and the
// eligibility guard (verified-trade participation + self-rating block).
router.get('/reputation/node/:nodeId', protect, getNodeReputation);
router.get('/reputation/:wallet', protect, getReputationByWallet);
router.get('/ratings', protect, listRatings);
router.post(
  '/ratings',
  protect,
  createRatingRateLimiter(),
  validateRatingBody,
  submitRating,
);

module.exports = router;
