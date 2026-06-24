const express = require('express');
const { protect } = require('../middleware/auth');
const { createApiRateLimiter } = require('../middleware/rateLimit');
const { listEscrows, getEscrow } = require('../controllers/escrowController');

const router = express.Router();
const apiRateLimit = createApiRateLimiter();

router.get('/', protect, apiRateLimit, listEscrows);
router.get('/:escrowId', protect, getEscrow);

module.exports = router;
