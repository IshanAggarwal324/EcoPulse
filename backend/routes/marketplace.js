const express = require('express');
const { getOrders, getOrderById } = require('../controllers/marketplaceController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.get('/orders', protect, getOrders);
router.get('/orders/:listingId', protect, getOrderById);

module.exports = router;
