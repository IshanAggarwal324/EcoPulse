const { getFetchTimeoutMs, isPrivateHost } = require('../../config/publicGrid');

/**
 * Outbound HTTP client for public-grid adapters (Sub-module 1.5.2 / guardrail 1.5).
 *
 * Adapters never call `fetch` directly. They go through `safeFetch`, which
 * enforces the SSRF contract:
 *
 *   1. HTTPS-only — a plain http(s) typo or an http provider URL is rejected.
 *   2. Host allowlist — the resolved hostname MUST be in the adapter-declared
 *      `allowedHosts`. An admin cannot inject a URL because adapters build
 *      URLs from constants + validated config; this is the second check.
 *   3. Private-address blocking — even an allowlisted host that resolves to a
 *      loopback / private / link-local / cloud-metadata address is refused
 *      (defense against DNS rebinding).
 *   4. Bounded timeout — one dead provider can't stall the poll loop.
 *   5. No credentials in URLs — a URL with embedded userinfo is rejected.
 *
 * The caller passes the adapter's `allowedHosts` so this module stays generic.
 */

const assertSafeUrl = (urlString, allowedHosts) => {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL must be a string');
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`unparseable provider URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('provider requests must use HTTPS');
  }

  // Reject embedded credentials (user:pass@host or key in userinfo).
  if (parsed.username || parsed.password) {
    throw new Error('provider URLs must not carry embedded credentials');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error('provider URL is missing a hostname');
  }

  // Allowlist check. Hosts are matched exactly or as a parent domain (so an
  // adapter can allowlist "api.eia.gov" and call subpaths without leaking
  // control to arbitrary siblings). No wildcards are honored.
  const allow = Array.isArray(allowedHosts) ? allowedHosts.map((h) => String(h).toLowerCase()) : [];
  const hostAllowed =
    allow.length > 0 &&
    (allow.includes(hostname) ||
      allow.some((base) => hostname === base || hostname.endsWith(`.${base}`)));

  if (!hostAllowed) {
    throw new Error(`provider host "${hostname}" is not in the adapter allowlist`);
  }

  if (isPrivateHost(hostname)) {
    throw new Error(`provider host "${hostname}" resolves to a blocked private/reserved address`);
  }

  return { parsed, hostname };
};

/**
 * Fetch with the SSRF + timeout contract above. The API key (when present) is
 * sent only via a header the adapter supplies in `options.headers` — never in
 * the URL — so it never lands in a log line or the dedup key.
 *
 * @param {string} url          Absolute https URL built by the adapter.
 * @param {object} [options]
 * @param {string[]} options.allowedHosts  Adapter-declared host allowlist.
 * @param {number}  [options.timeoutMs]    Per-request timeout.
 * @param {object}  [options.headers]      Extra headers (e.g. x-api-key).
 * @param {AbortSignal} [options.signal]   Optional caller signal (manual poll).
 * @returns {Promise<Response>} the fetch Response (caller reads .json/.text).
 */
const safeFetch = async (url, options = {}) => {
  const { allowedHosts, timeoutMs, headers, signal } = options;

  // Throws on any contract violation before any network I/O.
  assertSafeUrl(url, allowedHosts);

  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : getFetchTimeoutMs();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Honor a caller-provided signal (e.g. shutdown) alongside the timeout.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain;q=0.5, */*;q=0.1',
        ...headers,
      },
      signal: controller.signal,
      // Keep redirects explicit & bounded — a 3xx to an internal host would
      // otherwise bypass the allowlist check done above.
      redirect: 'error',
    });
    return response;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`provider request timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { safeFetch, assertSafeUrl };
