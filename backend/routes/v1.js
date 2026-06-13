const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');

// Base v1 route for testing
router.get('/', (req, res) => {
  res.json({ message: 'Welcome to EcoPulse API v1' });
});

// Feature Routes
router.use('/auth', require('./auth'));
router.use('/nodes', require('./nodes'));
router.use('/readings', require('./readings'));
router.use('/forecast', require('./forecast'));
router.use('/analytics', require('./analytics'));
router.use('/trades', require('./trades'));
router.use('/marketplace', require('./marketplace'));
router.use('/assistant', require('./assistant'));
router.use('/admin', protect, authorize('admin', 'moderator'), require('./admin'));

module.exports = router;
