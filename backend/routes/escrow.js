const express = require('express');
const { protect } = require('../middleware/auth');
const { createApiRateLimiter } = require('../middleware/rateLimit');
const { listEscrows, getEscrow, indexEscrowTransaction } = require('../controllers/escrowController');

const router = express.Router();
const apiRateLimit = createApiRateLimiter();

router.get('/', protect, apiRateLimit, listEscrows);
// Client signs the escrow transaction, then asks the backend to index its receipt.
router.post('/index', protect, apiRateLimit, indexEscrowTransaction);
router.get('/:escrowId', protect, getEscrow);

module.exports = router;
