const GENAI_SERVICE_URL = process.env.GENAI_SERVICE_URL || 'http://localhost:8001';

async function postToGenaiService(path, body) {
  const url = `${GENAI_SERVICE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function postNarrate(metrics, meta) {
  const { meta: _meta, periodLabel, ...rest } = metrics;
  const payload = {
    metrics: { ...rest, periodLabel },
    meta: meta ?? _meta,
  };
  return postToGenaiService('/reports/narrate', payload);
}

async function postChat(payload) {
  return postToGenaiService('/assistant/chat', payload);
}

module.exports = { postToGenaiService, postNarrate, postChat };
