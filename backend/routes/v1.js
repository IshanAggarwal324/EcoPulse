const express = require('express');
const router = express.Router();

// Base v1 route for testing
router.get('/', (req, res) => {
  res.json({ message: 'Welcome to EcoPulse API v1' });
});

// Feature Routes
router.use('/auth', require('./auth'));

// You will mount more feature routes here later, e.g.:
// router.use('/users', require('./userRoutes'));
// router.use('/nodes', require('./nodeRoutes'));

module.exports = router;
