const { test } = require('node:test');
const assert = require('node:assert');
const { validateEnvironment } = require('../config/env');
const { isConfigured, getPublicCaptchaConfig } = require('../middleware/captchaVerify');

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-chars-long',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars-long',
  MONGO_URI: 'mongodb://localhost:27017/ecopulse_test',
  CORS_ORIGIN: 'https://app.example.com',
  INTERNAL_SERVICE_API_KEY: 'shared-internal-key',
  RECAPTCHA_SECRET: 'recaptcha-test-secret',
  REDIS_URL: 'redis://localhost:6379',
  AI_SERVICE_URL: 'http://ai-service:8000',
  GENAI_SERVICE_URL: 'http://genai-service:8001',
};

const withEnv = (overrides, fn) => {
  const snapshot = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
};

test('validateEnvironment requires CAPTCHA in production', () => {
  withEnv(PRODUCTION_ENV, () => {
    delete process.env.RECAPTCHA_SECRET;
    delete process.env.CAPTCHA_SECRET;
    delete process.env.HCAPTCHA_SECRET;
    delete process.env.TURNSTILE_SECRET;

    assert.throws(
      () => validateEnvironment(),
      (err) => err.message.includes('CAPTCHA provider must be configured'),
    );
  });
});

test('validateEnvironment passes production checks when CAPTCHA is configured', () => {
  withEnv(PRODUCTION_ENV, () => {
    assert.doesNotThrow(() => validateEnvironment());
  });
});

test('isConfigured detects configured CAPTCHA providers', () => {
  withEnv({ RECAPTCHA_SECRET: 'secret' }, () => {
    assert.strictEqual(isConfigured(), true);
    assert.strictEqual(getPublicCaptchaConfig().required, true);
  });

  withEnv({}, () => {
    delete process.env.RECAPTCHA_SECRET;
    delete process.env.CAPTCHA_SECRET;
    delete process.env.HCAPTCHA_SECRET;
    delete process.env.TURNSTILE_SECRET;
    delete process.env.CAPTCHA_PROVIDER;
    assert.strictEqual(isConfigured(), false);
  });
});

test('captchaVerify rejects registration in production when CAPTCHA is not configured', () => {
  const { captchaVerify } = require('../middleware/captchaVerify');

  withEnv({ NODE_ENV: 'production' }, () => {
    delete process.env.RECAPTCHA_SECRET;
    delete process.env.CAPTCHA_SECRET;
    delete process.env.HCAPTCHA_SECRET;
    delete process.env.TURNSTILE_SECRET;

    const req = { body: {}, ip: '127.0.0.1' };
    let statusCode;
    let payload;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        payload = body;
      },
    };
    let nextCalled = false;

    captchaVerify(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusCode, 503);
    assert.strictEqual(payload.code, 'CAPTCHA_NOT_CONFIGURED');
  });
});

test('captchaVerify skips verification in non-production when CAPTCHA is not configured', () => {
  const { captchaVerify } = require('../middleware/captchaVerify');

  withEnv({ NODE_ENV: 'development' }, () => {
    delete process.env.RECAPTCHA_SECRET;
    delete process.env.CAPTCHA_SECRET;
    delete process.env.HCAPTCHA_SECRET;
    delete process.env.TURNSTILE_SECRET;

    let nextCalled = false;
    captchaVerify({ body: {}, ip: '127.0.0.1' }, { status: () => ({ json: () => {} }) }, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true);
  });
});
