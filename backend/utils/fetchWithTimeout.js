/**
 * Shared fetch wrapper with AbortSignal timeout (M5).
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = null) {
  const parsed = parseInt(
    timeoutMs ?? process.env.UPSTREAM_FETCH_TIMEOUT_MS ?? '20000',
    10,
  );
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
