const express = require('express');
const router = express.Router();
const { protect, authorize, requireEmailVerified, requirePasswordCurrent } = require('../middleware/auth');

// Auth routes (login, password change, etc.) are mounted WITHOUT the password
// guard so a flagged user can still change their password to clear the flag.
const guardedUser = [protect, requirePasswordCurrent, requireEmailVerified];

// Base v1 route for testing
router.get('/', (req, res) => {
  res.json({ message: 'Welcome to EcoPulse API v1' });
});

// Auth routes — /me allowed before verification; profile/password enforce verification
router.use('/auth', require('./auth'));

// Feature routes require authentication, a current (strong) password, and a verified email (when enabled)
router.use('/nodes', ...guardedUser, require('./nodes'));
router.use('/readings', ...guardedUser, require('./readings'));
router.use('/forecast', ...guardedUser, require('./forecast'));
router.use('/analytics', ...guardedUser, require('./analytics'));
router.use('/trades', ...guardedUser, require('./trades'));
router.use('/marketplace', ...guardedUser, require('./marketplace'));
router.use('/pricing', ...guardedUser, require('./pricing'));
router.use('/trading', ...guardedUser, require('./autoPolicy'));
router.use('/assistant', ...guardedUser, require('./assistant'));
router.use('/admin', protect, requirePasswordCurrent, authorize('admin', 'moderator'), require('./admin'));

// Sub-module 1.2.5 — device HTTP telemetry push. Auth is device-based
// (x-device-id / x-api-key via deviceAuth), so this is mounted OUTSIDE the
// guardedUser chain and does not require a user JWT.
router.use('/telemetry', require('./telemetry'));

module.exports = router;
