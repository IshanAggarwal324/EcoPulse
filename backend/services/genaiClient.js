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

module.exports = { postToGenaiService };
