const express = require('express');
const router = express.Router();

// Base v1 route for testing
router.get('/', (req, res) => {
  res.json({ message: 'Welcome to EcoPulse API v1' });
});

// Feature Routes
router.use('/auth', require('./auth'));
router.use('/nodes', require('./nodes'));
router.use('/readings', require('./readings'));
router.use('/forecast', require('./forecast'));

module.exports = router;
