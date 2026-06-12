const GENAI_SERVICE_URL = process.env.GENAI_SERVICE_URL || 'http://localhost:8001';

class GenaiServiceError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'GenaiServiceError';
    this.status = status;
    this.details = details;
  }
}

async function postToGenaiService(path, body) {
  const url = `${GENAI_SERVICE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function sendGenaiRequest(fn) {
  let response;
  try {
    response = await fn();
  } catch (error) {
    throw new GenaiServiceError('GenAI service unavailable', 503, error.message);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new GenaiServiceError(
      'Error communicating with GenAI service',
      response.status,
      errorText,
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
  return sendGenaiRequest(() => postToGenaiService('/assistant/chat', payload));
}

async function fetchDocChunks(query, topK = 3) {
  try {
    const response = await postToGenaiService('/assistant/doc-chunks', { query, top_k: topK });
    if (!response.ok) return [];
    const data = await response.json();
    return data.chunks || [];
  } catch {
    return [];
  }
}

module.exports = { GenaiServiceError, sendGenaiRequest, postToGenaiService, postNarrate, postChat, fetchDocChunks };
