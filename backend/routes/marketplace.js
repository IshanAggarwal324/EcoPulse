const express = require('express');
const { getOrders, getOrderById } = require('../controllers/marketplaceController');

const router = express.Router();

router.get('/orders', getOrders);
router.get('/orders/:listingId', getOrderById);

module.exports = router;
