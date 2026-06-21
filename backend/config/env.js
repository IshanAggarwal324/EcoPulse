const crypto = require('crypto');
const { isConfigured: isCaptchaConfigured } = require('../middleware/captchaVerify');

/** SHA-256 of the well-known Hardhat account #0 key (compare only — never store the key in repo). */
// gitleaks:allow
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

    if (!isCaptchaConfigured()) {
      issues.push(
        'A CAPTCHA provider must be configured in production (RECAPTCHA_SECRET, HCAPTCHA_SECRET, TURNSTILE_SECRET, or CAPTCHA_SECRET)',
      );
    }

    if (!process.env.REDIS_URL && !process.env.REDIS_TLS_URL) {
      issues.push('REDIS_URL (or REDIS_TLS_URL) must be set in production for distributed rate limiting');
    }

    if (!process.env.AI_SERVICE_URL) {
      issues.push('AI_SERVICE_URL must be set in production');
    }

    if (!process.env.GENAI_SERVICE_URL) {
      issues.push('GENAI_SERVICE_URL must be set in production');
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

  // Sub-module 1.4.1 — surface an invalid INGESTION_MODE without crashing so a
  // typo can't silently fall back and enable a source that should be off.
  const ingestionMode = require('./ingestionMode');
  if (ingestionMode.hasInvalidMode()) {
    console.warn(
      `WARNING: INGESTION_MODE="${process.env.INGESTION_MODE}" is invalid. ` +
        `Valid modes: ${ingestionMode.VALID_MODES.join(', ')}. ` +
        `Falling back to "${ingestionMode.getIngestionMode()}".`,
    );
  }

  // Guardrail 1.4: in production, the embedded simulator MUST NOT run when the
  // simulator is locked down (public_api / device modes).
  if (isProduction && ingestionMode.isSimulatorLockedDown()) {
    const simEmbedded = String(process.env.SIMULATOR_EMBEDDED || '').toLowerCase() === 'true';
    if (simEmbedded) {
      console.warn(
        'WARNING: SIMULATOR_EMBEDDED=true is ignored in production with ' +
          `INGESTION_MODE=${ingestionMode.getIngestionMode()} (simulator locked down).`,
      );
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
