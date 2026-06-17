const https = require('https');

const isConfigured = () => Boolean(getProvider());

const PROVIDER_CONFIG = {
  recaptcha: {
    verifyUrl: 'https://www.google.com/recaptcha/api/siteverify',
    secretEnv: 'RECAPTCHA_SECRET',
  },
  hcaptcha: {
    verifyUrl: 'https://api.hcaptcha.com/siteverify',
    secretEnv: 'HCAPTCHA_SECRET',
  },
  turnstile: {
    verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    secretEnv: 'TURNSTILE_SECRET',
  },
};

function getProvider() {
  const explicit = process.env.CAPTCHA_PROVIDER;
  if (explicit && PROVIDER_CONFIG[explicit]) {
    return explicit;
  }
  for (const [name, config] of Object.entries(PROVIDER_CONFIG)) {
    if (process.env[config.secretEnv]) {
      return name;
    }
  }
  if (process.env.CAPTCHA_SECRET) {
    return 'recaptcha';
  }
  return null;
}

function verifyToken(provider, token, remoteIp) {
  return new Promise((resolve, reject) => {
    const config = PROVIDER_CONFIG[provider];
    const secret = process.env[config.secretEnv] || process.env.CAPTCHA_SECRET;

    const postData = new URLSearchParams();
    postData.append('secret', secret);
    postData.append('response', token);
    if (remoteIp) {
      postData.append('remoteip', remoteIp);
    }

    const url = new URL(config.verifyUrl);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData.toString()),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid CAPTCHA verification response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });
}

function getPublicCaptchaConfig() {
  const provider = getProvider();
  return {
    required: Boolean(provider),
    provider: provider || null,
  };
}

function captchaVerify(req, res, next) {
  const provider = getProvider();

  if (!provider) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('CAPTCHA not configured in production — registration is unprotected');
    }
    return next();
  }

  const token = req.body?.captchaToken;
  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'CAPTCHA verification is required',
      code: 'CAPTCHA_REQUIRED',
    });
  }

  verifyToken(provider, token, req.ip)
    .then((result) => {
      const success = result.success === true;

      if (provider === 'recaptcha' && result.score !== undefined) {
        const threshold = parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5');
        if (result.score < threshold) {
          return res.status(403).json({
            success: false,
            message: 'CAPTCHA verification failed',
            code: 'CAPTCHA_FAILED',
          });
        }
      }

      if (!success) {
        return res.status(403).json({
          success: false,
          message: 'CAPTCHA verification failed',
          code: 'CAPTCHA_FAILED',
        });
      }

      next();
    })
    .catch(() => {
      res.status(500).json({
        success: false,
        message: 'CAPTCHA verification service unavailable',
        code: 'CAPTCHA_ERROR',
      });
    });
}

module.exports = { captchaVerify, isConfigured, getProvider, getPublicCaptchaConfig };
