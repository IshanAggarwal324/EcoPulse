const { getGenaiServiceUrl } = require('../config/serviceUrls');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { logger } = require('../utils/logger');
const { scrubMessage } = require('../utils/scrubLog');

const TARGET_SERVICE = 'genai-service';

// Chat gets a shorter, dedicated upstream timeout than the shared
// UPSTREAM_FETCH_TIMEOUT_MS default (20000ms), so it leaves margin under the
// frontend's 20000ms budget for a fallback reply to win the race instead of a
// bare timeout. See frontend/utils/api.js for the full coordinated budget chain.
const CHAT_UPSTREAM_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.GENAI_CHAT_TIMEOUT_MS ?? '12000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12000;
})();

// Doc-chunk RAG retrieval is OPTIONAL prompt enrichment: fetchDocChunks()
// swallows every failure and returns [], so a slow/asleep genai-service must
// never be allowed to spend the caller's whole budget here. It previously took
// no timeout argument, silently inheriting the shared 20000ms
// UPSTREAM_FETCH_TIMEOUT_MS default. Because the chat handler awaits doc-chunks
// and THEN awaits postChat (12000ms), the worst case was 20000+12000=32000ms —
// past the frontend's 20000ms abort, so a cold genai-service surfaced as a raw
// "Request timed out after 20000ms" instead of the intended graceful 503.
// A short budget keeps 3000+12000=15000ms comfortably inside that 20000ms.
const DOC_CHUNKS_UPSTREAM_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.GENAI_DOC_CHUNKS_TIMEOUT_MS ?? '3000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
})();

const GENAI_SERVICE_URL = getGenaiServiceUrl();
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !INTERNAL_SERVICE_API_KEY) {
  throw new Error('INTERNAL_SERVICE_API_KEY must be set in production');
}

class GenaiServiceError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'GenaiServiceError';
    this.status = status;
    this.details = details;
  }
}

const sanitizeDetails = (details) => {
  if (!details) return undefined;
  if (isProduction) return undefined;
  return String(details).slice(0, 500);
};

async function postToGenaiService(path, body, timeoutMs) {
  const url = `${GENAI_SERVICE_URL}${path}`;
  logger.debug('outbound request to genai-service', {
    targetService: TARGET_SERVICE,
    path,
    method: 'POST',
  });
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  return response;
}

const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendGenaiRequest(fn, retries = MAX_RETRIES) {
  let response;
  try {
    response = await fn();
  } catch (error) {
    logger.warn('genai-service call failed', {
      targetService: TARGET_SERVICE,
      // Scrubbed: raw errors often embed internal hostnames/IPs (e.g.
      // "ECONNREFUSED 10.0.0.9:8001") which must not reach log aggregation.
      errorMessage: scrubMessage(error.message),
    });
    throw new GenaiServiceError('GenAI service unavailable', 503, sanitizeDetails(error.message));
  }

  if (response.status === 429 && retries > 0) {
    await sleep(RETRY_DELAY_MS);
    return sendGenaiRequest(fn, retries - 1);
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn('genai-service returned error', {
      targetService: TARGET_SERVICE,
      status: response.status,
    });
    throw new GenaiServiceError(
      'Error communicating with GenAI service',
      response.status,
      sanitizeDetails(errorText),
    );
  }

  return response.json();
}

async function postNarrate(metrics, meta) {
  const { meta: _meta, periodLabel, ...rest } = metrics;
  const payload = {
    metrics: { ...rest, periodLabel },
    meta: meta ?? _meta,
  };
  return sendGenaiRequest(() => postToGenaiService('/reports/narrate', payload));
}

async function postChat(payload) {
  return sendGenaiRequest(() => postToGenaiService('/assistant/chat', payload, CHAT_UPSTREAM_TIMEOUT_MS));
}

async function fetchDocChunks(query, topK = 3) {
  try {
    const response = await postToGenaiService(
      '/assistant/doc-chunks',
      { query, top_k: topK },
      DOC_CHUNKS_UPSTREAM_TIMEOUT_MS,
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.chunks || [];
  } catch {
    return [];
  }
}

async function reindexAssistantDocs() {
  return sendGenaiRequest(() => postToGenaiService('/assistant/reindex', {}));
}

module.exports = { GenaiServiceError, sendGenaiRequest, postToGenaiService, postNarrate, postChat, fetchDocChunks, reindexAssistantDocs };
