const bcrypt = require('bcryptjs');
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
const DUMMY_BCRYPT_HASH = '$2a$10$8wM17rRLf4vH4vPSc6Qh9.jv4CuUu63eVUsM8c7kwh28ykVfoCENW';

const isProduction = process.env.NODE_ENV === 'production';
const cookieSameSite = isProduction ? 'none' : 'lax';

const getAccessCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
  path: '/',
  maxAge: 15 * 60 * 1000,
});

const getRefreshCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
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
  // Module 8.4 — null until the wallet is cryptographically linked. The UI uses
  // this to prompt re-linking of legacy manually-entered addresses.
  walletLinkedAt: user.walletLinkedAt ?? null,
  role: user.role,
  isBanned: user.isBanned,
  isEmailVerified: user.isEmailVerified ?? false,
  mustChangePassword: user.mustChangePassword ?? false,
  preferences: user.preferences,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (process.env.REGISTRATION_OPEN === 'false') {
    return res.status(403).json({
      success: false,
      message: 'Registration is currently closed. Please contact an administrator.',
      code: 'REGISTRATION_CLOSED',
    });
  }

  const errors = collectErrors([
    validateName(name),
    validateEmail(email),
    validatePassword(password),
  ]);

  if (errors) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }

  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    // Keep response shape and timing similar to reduce account enumeration risk.
    await bcrypt.compare(password || '', DUMMY_BCRYPT_HASH);
    return res.status(200).json({
      success: true,
      message: 'If registration is allowed for this email, you can sign in after completing registration.',
    });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const { rawToken, hashed, expires } = User.generateEmailVerificationToken();

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashedPassword,
    walletAddress: null,
    isEmailVerified: false,
    emailVerificationToken: hashed,
    emailVerificationExpires: expires,
  });

  // Attempt to send verification email; do not block registration if email is unconfigured.
  try {
    const { isConfigured: emailConfigured, sendEmail, buildVerificationEmailBody, buildVerificationUrl } =
      require('../services/emailService');
    if (emailConfigured()) {
      const verificationUrl = buildVerificationUrl(rawToken);
      await sendEmail({
        to: user.email,
        subject: 'Verify Your EcoPulse Account',
        html: buildVerificationEmailBody({ userName: user.name, verificationUrl }),
      });
    }
  } catch (emailErr) {
    console.warn('Verification email failed to send:', emailErr.message);
  }

  const tokens = generateTokenPair(
    user._id,
    user.refreshTokenVersion || 0,
    user.accessTokenVersion || 0,
  );
  setAuthCookies(res, tokens);

  res.status(201).json({
    success: true,
    message: 'User registered successfully. Please verify your email address.',
    data: { user: toUserResponse(user) },
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const errors = collectErrors([validateEmail(email), validatePassword(password, { requireComplexity: false })]);
  if (errors) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }

  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+password +loginAttempts +lockUntil +refreshTokenVersion +accessTokenVersion +mustChangePassword');
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

  // Lazy weak-password detection: the stored bcrypt hash hides password strength,
  // but we have the plaintext at login. If the user's password fails the current
  // complexity policy, flag them for a forced change. Non-disruptive: they are
  // already authenticated and can change their own password via PUT /auth/password.
  const passwordNowWeak = Boolean(validatePassword(password));
  if (passwordNowWeak !== user.mustChangePassword) {
    user.mustChangePassword = passwordNowWeak;
    await User.updateOne({ _id: user._id }, { $set: { mustChangePassword: passwordNowWeak } });
  }

  const tokens = generateTokenPair(
    user._id,
    user.refreshTokenVersion || 0,
    user.accessTokenVersion || 0,
  );
  setAuthCookies(res, tokens);

  res.status(200).json({
    success: true,
    message: 'Logged in successfully',
    data: { user: toUserResponse(user) },
  });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken || getCookieValue(req.headers.cookie, 'refreshToken');

  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'Refresh token is required' });
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.id).select('+refreshTokenVersion +accessTokenVersion');

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    if (user.deletedAt) {
      return res.status(401).json({ success: false, message: 'This account has been deactivated', code: 'ACCOUNT_DEACTIVATED' });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: 'This account has been banned', code: 'ACCOUNT_BANNED' });
    }

    if ((decoded.version ?? 0) !== (user.refreshTokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token has been revoked',
        code: 'REFRESH_TOKEN_REVOKED',
      });
    }

    const rotatedUser = await User.findOneAndUpdate(
      { _id: user._id, refreshTokenVersion: user.refreshTokenVersion || 0 },
      { $inc: { refreshTokenVersion: 1 } },
      { new: true },
    ).select('+refreshTokenVersion +accessTokenVersion');

    if (!rotatedUser) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token has already been used',
        code: 'REFRESH_TOKEN_REUSED',
      });
    }

    const tokens = generateTokenPair(
      rotatedUser._id,
      rotatedUser.refreshTokenVersion || 0,
      rotatedUser.accessTokenVersion || 0,
    );
    setAuthCookies(res, tokens);

    res.status(200).json({
      success: true,
      data: { user: toUserResponse(rotatedUser) },
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
    // Module 8.4 — the wallet address is the source of truth for carbon
    // balances, settlements and trades, so it MUST be bound via a signed
    // EIP-712 challenge (/auth/wallet/link), never typed by hand. Allowing a
    // free-text set here would let any user claim ANYONE's wallet. Clearing is
    // only permitted through /auth/wallet/unlink (which re-authenticates).
    const requested = walletAddress ? String(walletAddress).trim() : null;
    const current = req.user.walletAddress ? String(req.user.walletAddress).toLowerCase() : null;
    if (requested && requested.toLowerCase() !== current) {
      return res.status(400).json({
        success: false,
        message: 'Use the wallet linking flow (Sign to link) to set your wallet address.',
        code: 'WALLET_LINK_REQUIRED',
      });
    }
    // No-op: either clearing (must use unlink) or setting the same value. We do
    // not persist anything so the signed attestation state is preserved.
  }

  if (preferences !== undefined) {
    const ALLOWED_PREFS = ['emailNotifications', 'gridAlerts', 'energyUnit'];
    const currentPrefs = req.user.preferences?.toObject?.() || req.user.preferences || {};
    const sanitizedPrefs = {};
    for (const key of ALLOWED_PREFS) {
      if (key in preferences) {
        sanitizedPrefs[key] = preferences[key];
      } else {
        sanitizedPrefs[key] = currentPrefs[key];
      }
    }
    if (sanitizedPrefs.energyUnit && !['kWh', 'MWh'].includes(sanitizedPrefs.energyUnit)) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: ['energyUnit must be kWh or MWh'],
      });
    }
    if ('emailNotifications' in sanitizedPrefs && typeof sanitizedPrefs.emailNotifications !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: ['emailNotifications must be a boolean'],
      });
    }
    if ('gridAlerts' in sanitizedPrefs && typeof sanitizedPrefs.gridAlerts !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: ['gridAlerts must be a boolean'],
      });
    }
    updates.preferences = sanitizedPrefs;
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
    validatePassword(currentPassword, { requireComplexity: false }),
    validatePassword(newPassword),
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

  const user = await User.findById(req.user._id).select('+password +refreshTokenVersion +accessTokenVersion');
  const isMatch = await bcrypt.compare(currentPassword, user.password);

  if (!isMatch) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(newPassword, salt);
  user.refreshTokenVersion = (user.refreshTokenVersion || 0) + 1;
  user.accessTokenVersion = (user.accessTokenVersion || 0) + 1;
  user.mustChangePassword = false;
  await user.save();

  const tokens = generateTokenPair(
    user._id,
    user.refreshTokenVersion || 0,
    user.accessTokenVersion || 0,
  );
  setAuthCookies(res, tokens);

  res.status(200).json({
    success: true,
    message: 'Password updated successfully',
    data: { mustChangePassword: false },
  });
});

const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken || getCookieValue(req.headers.cookie, 'refreshToken');

  if (refreshToken) {
    try {
      const decoded = verifyRefreshToken(refreshToken);
      await User.updateOne(
        { _id: decoded.id, refreshTokenVersion: decoded.version ?? 0 },
        { $inc: { refreshTokenVersion: 1, accessTokenVersion: 1 } },
      );
    } catch {
      // Always clear cookies even if token is invalid.
    }
  } else if (req.user?._id) {
    // No refresh token (e.g. only an access cookie present) — still revoke
    // the current access token by bumping its version.
    try {
      await User.updateOne(
        { _id: req.user._id },
        { $inc: { accessTokenVersion: 1 } },
      );
    } catch {
      // Non-fatal: cookies are still cleared below.
    }
  }

  clearAuthCookies(res);
  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
});

const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'Verification token is required' });
  }

  const hashedToken = User.hashEmailVerificationToken(token);

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: new Date() },
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!user) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired verification token',
      code: 'VERIFICATION_TOKEN_INVALID',
    });
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = null;
  user.emailVerificationExpires = null;
  await user.save();

  await auditService.log({
    actor: user,
    action: 'EMAIL_VERIFIED',
    resourceType: 'user',
    resourceId: user._id,
    req,
  });

  res.status(200).json({
    success: true,
    message: 'Email verified successfully',
    data: { user: toUserResponse(user) },
  });
});

const resendVerification = asyncHandler(async (req, res) => {
  const email = (req.body?.email || req.user?.email || '').toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  const user = await User.findOne({ email }).select('+isEmailVerified +emailVerificationToken');

  if (!user) {
    return res.status(200).json({
      success: false,
      status: 'user_not_found',
      message: 'Unable to find the account for email verification.',
    });
  }

  if (user.isEmailVerified) {
    return res.status(200).json({
      success: true,
      status: 'already_verified',
      message: 'Your email address is already verified.',
    });
  }

  const { rawToken, hashed, expires } = User.generateEmailVerificationToken();
  user.emailVerificationToken = hashed;
  user.emailVerificationExpires = expires;
  await user.save();

  const {
    isConfigured: emailConfigured,
    sendEmail,
    buildVerificationEmailBody,
    buildVerificationUrl,
  } = require('../services/emailService');

  if (!emailConfigured()) {
    return res.status(200).json({
      success: false,
      status: 'not_configured',
      message: 'Email delivery is not configured right now. Please contact support.',
    });
  }

  try {
    const verificationUrl = buildVerificationUrl(rawToken);
    await sendEmail({
      to: user.email,
      subject: 'Verify Your EcoPulse Account',
      html: buildVerificationEmailBody({ userName: user.name, verificationUrl }),
    });
  } catch (emailErr) {
    console.warn('Resend verification email failed:', emailErr.message);
    return res.status(200).json({
      success: false,
      status: 'send_failed',
      message: 'Verification email could not be sent. Please try again later.',
    });
  }

  res.status(200).json({
    success: true,
    status: 'sent',
    message: 'Verification email sent. Check your inbox.',
  });
});

const getCaptchaConfig = asyncHandler(async (req, res) => {
  const { getPublicCaptchaConfig } = require('../middleware/captchaVerify');
  res.status(200).json({
    success: true,
    captcha: getPublicCaptchaConfig(),
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
  verifyEmail,
  resendVerification,
  getCaptchaConfig,
};
