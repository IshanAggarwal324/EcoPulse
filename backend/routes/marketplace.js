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
const { createBuyOrderRateLimiter } = require('../middleware/rateLimit');

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

module.exports = router;
