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
  verifyEmail,
  resendVerification,
  getCaptchaConfig,
} = require('../controllers/authController');
const { protect, requireEmailVerified } = require('../middleware/auth');
const { createAuthRateLimiter, createProfileRateLimiter } = require('../middleware/rateLimit');
const { captchaVerify } = require('../middleware/captchaVerify');

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

const resendVerificationLimiter = createAuthRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 3,
  message: 'Too many verification email requests. Please try again later.',
});

const verifyEmailLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many verification attempts. Please try again later.',
});

const profileLimiter = createProfileRateLimiter();

router.post('/register', registerLimiter, captchaVerify, register);
router.get('/captcha-config', getCaptchaConfig);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);
router.post('/verify-email', verifyEmailLimiter, verifyEmail);
router.post('/resend-verification', protect, resendVerificationLimiter, resendVerification);

router.get('/me', protect, getMe);
router.put('/profile', protect, profileLimiter, requireEmailVerified, updateProfile);
router.put('/password', protect, profileLimiter, requireEmailVerified, updatePassword);

module.exports = router;
