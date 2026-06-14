const express = require('express');
const router = express.Router();
const {
  register,
  login,
  refresh,
  logout,
  getMe,
  updateProfile,
  updatePassword,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { createAuthRateLimiter } = require('../middleware/rateLimit');

const registerLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  message: 'Too many registration attempts. Please try again later.',
});

const loginLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many login attempts. Please try again later.',
});

const refreshLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  message: 'Too many token refresh attempts. Please try again later.',
});

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);

router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);
router.put('/password', protect, updatePassword);

module.exports = router;
