const PROVIDERS = ['turnstile', 'hcaptcha', 'recaptcha'];

const trim = (value) => String(value || '').trim();

export function getCaptchaProvider() {
  const explicit = trim(import.meta.env.VITE_CAPTCHA_PROVIDER).toLowerCase();
  if (PROVIDERS.includes(explicit)) {
    return explicit;
  }
  if (trim(import.meta.env.VITE_TURNSTILE_SITE_KEY)) return 'turnstile';
  if (trim(import.meta.env.VITE_HCAPTCHA_SITE_KEY)) return 'hcaptcha';
  if (trim(import.meta.env.VITE_RECAPTCHA_SITE_KEY)) return 'recaptcha';
  return null;
}

export function getCaptchaSiteKey(provider = getCaptchaProvider()) {
  if (!provider) return '';
  if (provider === 'turnstile') return trim(import.meta.env.VITE_TURNSTILE_SITE_KEY);
  if (provider === 'hcaptcha') return trim(import.meta.env.VITE_HCAPTCHA_SITE_KEY);
  if (provider === 'recaptcha') return trim(import.meta.env.VITE_RECAPTCHA_SITE_KEY);
  return '';
}

export function getRecaptchaVersion() {
  const version = trim(import.meta.env.VITE_RECAPTCHA_VERSION).toLowerCase();
  return version === 'v3' ? 'v3' : 'v2';
}

export function isCaptchaConfiguredLocally() {
  const provider = getCaptchaProvider();
  return Boolean(provider && getCaptchaSiteKey(provider));
}

export const CAPTCHA_SCRIPT_URLS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
  recaptcha: (siteKey, version) =>
    version === 'v3'
      ? `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
      : 'https://www.google.com/recaptcha/api.js?render=explicit',
};

let scriptPromises = {};

export function loadCaptchaScript(provider, recaptchaVersion = 'v2', siteKey = '') {
  if (!provider) {
    return Promise.reject(new Error('CAPTCHA provider is not configured'));
  }

  const src =
    provider === 'recaptcha'
      ? CAPTCHA_SCRIPT_URLS.recaptcha(siteKey, recaptchaVersion)
      : CAPTCHA_SCRIPT_URLS[provider];

  if (scriptPromises[src]) {
    return scriptPromises[src];
  }

  scriptPromises[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ecopulse-captcha="${provider}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(provider), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load CAPTCHA script')), {
        once: true,
      });
      if (existing.dataset.loaded === 'true') {
        resolve(provider);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.dataset.ecopulseCaptcha = provider;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve(provider);
    };
    script.onerror = () => reject(new Error('Failed to load CAPTCHA script'));
    document.head.appendChild(script);
  });

  return scriptPromises[src];
}

export async function executeRecaptchaV3(siteKey) {
  await loadCaptchaScript('recaptcha', 'v3', siteKey);
  if (!window.grecaptcha) {
    throw new Error('reCAPTCHA is not available');
  }
  return new Promise((resolve, reject) => {
    window.grecaptcha.ready(() => {
      window.grecaptcha
        .execute(siteKey, { action: 'register' })
        .then(resolve)
        .catch(reject);
    });
  });
}
