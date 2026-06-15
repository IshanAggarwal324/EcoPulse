const crypto = require('crypto');

/** SHA-256 of the well-known Hardhat account #0 key (compare only — never store the key in repo). */
const HARDHAT_DEFAULT_KEY_SHA256 = '60a09e4357868c1e9b801052726d061c370429f723db84523ed58ac354f6eb8a';

const isKnownDevPrivateKey = (privateKey) => {
  if (!privateKey) return false;
  const hash = crypto.createHash('sha256').update(privateKey).digest('hex');
  return hash === HARDHAT_DEFAULT_KEY_SHA256;
};

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const hasBlockchainConfig = () =>
  Boolean(process.env.RPC_URL || process.env.CARBON_CREDIT_ADDRESS || process.env.ENERGY_TRADING_ADDRESS);

const isEmailVerificationRequired = () => {
  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'false') return false;
  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true') return true;
  return process.env.NODE_ENV === 'production';
};

const validateEnvironment = () => {
  const issues = [];
  const isProduction = process.env.NODE_ENV === 'production';

  const accessSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

  if (!accessSecret || accessSecret.length < 32) {
    issues.push('JWT_ACCESS_SECRET (or JWT_SECRET) must be set and at least 32 characters');
  }

  if (isProduction) {
    if (!process.env.JWT_ACCESS_SECRET) {
      issues.push('JWT_ACCESS_SECRET must be set in production');
    }
    if (!process.env.JWT_REFRESH_SECRET) {
      issues.push('JWT_REFRESH_SECRET must be set in production');
    }
    if (accessSecret && refreshSecret && accessSecret === refreshSecret) {
      issues.push('JWT access and refresh secrets must be different in production');
    }

    if (!process.env.MONGO_URI) {
      issues.push('MONGO_URI must be set in production');
    }

    const corsOrigins = parseList(process.env.CORS_ORIGIN || process.env.FRONTEND_URL);
    if (corsOrigins.length === 0) {
      issues.push('CORS_ORIGIN (or FRONTEND_URL) must be set in production');
    }

    if (hasBlockchainConfig()) {
      if (!process.env.RPC_URL) issues.push('RPC_URL must be set when blockchain sync is enabled');
      if (!process.env.CARBON_CREDIT_ADDRESS) issues.push('CARBON_CREDIT_ADDRESS must be set when blockchain sync is enabled');
      if (!process.env.ENERGY_TRADING_ADDRESS) issues.push('ENERGY_TRADING_ADDRESS must be set when blockchain sync is enabled');
      if (!process.env.PRIVATE_KEY) {
        issues.push('PRIVATE_KEY must be set when blockchain sync is enabled');
      } else if (isKnownDevPrivateKey(process.env.PRIVATE_KEY)) {
        issues.push('PRIVATE_KEY cannot use the Hardhat default account in production');
      }
    }

    if (!process.env.INTERNAL_SERVICE_API_KEY) {
      issues.push('INTERNAL_SERVICE_API_KEY must be set in production');
    }

    if (!process.env.CAPTCHA_SECRET && !process.env.RECAPTCHA_SECRET && !process.env.HCAPTCHA_SECRET && !process.env.TURNSTILE_SECRET) {
      console.warn('WARNING: No CAPTCHA provider configured in production — registration is vulnerable to bots');
    }

    if (process.env.REGISTRATION_OPEN === undefined) {
      console.warn('TIP: Set REGISTRATION_OPEN=false to close registration if not accepting new users');
    }

    if (isEmailVerificationRequired()) {
      const { isConfigured } = require('../services/emailService');
      if (!isConfigured()) {
        console.warn('WARNING: Email verification is required but SMTP is not configured — users cannot verify accounts');
      }
    }
  }

  if (issues.length > 0) {
    const message = issues.map((issue) => `- ${issue}`).join('\n');
    throw new Error(`Environment validation failed:\n${message}`);
  }
};

module.exports = {
  validateEnvironment,
  isKnownDevPrivateKey,
  isEmailVerificationRequired,
};
