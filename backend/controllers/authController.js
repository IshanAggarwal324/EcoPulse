const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { generateTokenPair, verifyRefreshToken } = require('../utils/tokens');
const {
  validateEmail,
  validatePassword,
  validateName,
  validateWalletAddress,
  collectErrors,
} = require('../utils/validators');
const auditService = require('../services/auditService');

const getAccessCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 15 * 60 * 1000,
});

const getRefreshCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

const setAuthCookies = (res, tokens) => {
  res.cookie('accessToken', tokens.accessToken, getAccessCookieOptions());
  res.cookie('refreshToken', tokens.refreshToken, getRefreshCookieOptions());
};

const clearAuthCookies = (res) => {
  res.clearCookie('accessToken', getAccessCookieOptions());
  res.clearCookie('refreshToken', getRefreshCookieOptions());
};

const getCookieValue = (cookieHeader, key) => {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((part) => part.trim());
  const entry = parts.find((part) => part.startsWith(`${key}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(key.length + 1));
};

const toUserResponse = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  walletAddress: user.walletAddress,
  role: user.role,
  isBanned: user.isBanned,
  preferences: user.preferences,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const register = asyncHandler(async (req, res) => {
  const { name, email, password, walletAddress } = req.body;

  const errors = collectErrors([
    validateName(name),
    validateEmail(email),
    validatePassword(password),
    walletAddress ? validateWalletAddress(walletAddress) : null,
  ]);

  if (errors) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }

  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    if (existingUser.deletedAt) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated', code: 'ACCOUNT_DEACTIVATED' });
    }
    if (existingUser.isBanned) {
      return res.status(403).json({ success: false, message: 'This account has been banned', code: 'ACCOUNT_BANNED' });
    }
    return res.status(409).json({ success: false, message: 'A user with this email already exists' });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashedPassword,
    walletAddress: walletAddress?.trim() || null,
  });

  const tokens = generateTokenPair(user._id);
  setAuthCookies(res, tokens);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: { user: toUserResponse(user), ...tokens },
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const errors = collectErrors([validateEmail(email), validatePassword(password)]);
  if (errors) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select('+password +loginAttempts +lockUntil');
  if (!user) {
    await auditService.log({
      actor: null,
      action: 'AUTH_FAILED',
      resourceType: 'auth',
      resourceId: email.toLowerCase(),
      metadata: { reason: 'user_not_found', email: email.toLowerCase() },
      req,
      severity: 'warn',
    });

    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  if (user.deletedAt) {
    return res.status(401).json({ success: false, message: 'This account has been deactivated', code: 'ACCOUNT_DEACTIVATED' });
  }

  if (user.isBanned) {
    return res.status(403).json({ success: false, message: 'This account has been banned', code: 'ACCOUNT_BANNED' });
  }

  if (user.isLocked) {
    return res.status(423).json({ success: false, message: 'Account temporarily locked due to too many failed login attempts. Try again later.', code: 'ACCOUNT_LOCKED' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await user.incLoginAttempts();

    await auditService.log({
      actor: null,
      action: 'AUTH_FAILED',
      resourceType: 'auth',
      resourceId: email.toLowerCase(),
      metadata: {
        reason: 'invalid_password',
        loginAttempts: user.loginAttempts + 1,
        email: email.toLowerCase(),
      },
      req,
      severity: 'warn',
    });

    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  await user.resetLoginAttempts();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  user.lastLoginAt = new Date();

  const tokens = generateTokenPair(user._id);
  setAuthCookies(res, tokens);

  res.status(200).json({
    success: true,
    message: 'Logged in successfully',
    data: { user: toUserResponse(user), ...tokens },
  });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken || getCookieValue(req.headers.cookie, 'refreshToken');

  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'Refresh token is required' });
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    if (user.deletedAt) {
      return res.status(401).json({ success: false, message: 'This account has been deactivated', code: 'ACCOUNT_DEACTIVATED' });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: 'This account has been banned', code: 'ACCOUNT_BANNED' });
    }

    const tokens = generateTokenPair(user._id);
    setAuthCookies(res, tokens);

    res.status(200).json({
      success: true,
      data: { user: toUserResponse(user), ...tokens },
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Refresh token expired or invalid',
      code: 'REFRESH_TOKEN_INVALID',
    });
  }
});

const getMe = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: { user: toUserResponse(req.user) },
  });
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, walletAddress, preferences } = req.body;
  const updates = {};

  if (name !== undefined) {
    const nameError = validateName(name);
    if (nameError) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: [nameError] });
    }
    updates.name = name.trim();
  }

  if (walletAddress !== undefined) {
    const walletError = validateWalletAddress(walletAddress, { required: false });
    if (walletAddress && walletError) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: [walletError] });
    }
    updates.walletAddress = walletAddress?.trim() || null;
  }

  if (preferences !== undefined) {
    updates.preferences = {
      ...req.user.preferences?.toObject?.() || req.user.preferences || {},
      ...preferences,
    };
    if (updates.preferences.energyUnit && !['kWh', 'MWh'].includes(updates.preferences.energyUnit)) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: ['energyUnit must be kWh or MWh'],
      });
    }
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { user: toUserResponse(user) },
  });
});

const updatePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const errors = collectErrors([
    validatePassword(currentPassword),
    validatePassword(newPassword, { minLength: 8 }),
  ]);

  if (errors) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: ['New password must be different from current password'],
    });
  }

  const user = await User.findById(req.user._id).select('+password');
  const isMatch = await bcrypt.compare(currentPassword, user.password);

  if (!isMatch) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(newPassword, salt);
  await user.save();

  const tokens = generateTokenPair(user._id);
  setAuthCookies(res, tokens);

  res.status(200).json({
    success: true,
    message: 'Password updated successfully',
    data: { ...tokens },
  });
});

const logout = asyncHandler(async (req, res) => {
  clearAuthCookies(res);
  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  updateProfile,
  updatePassword,
};
