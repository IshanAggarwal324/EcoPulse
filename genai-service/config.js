require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

module.exports = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GENAI_MODEL: process.env.GENAI_MODEL || 'gemini-2.0-flash',
  GENAI_MAX_TOKENS: parseInt(process.env.GENAI_MAX_TOKENS || '800', 10),
  GENAI_ENABLED: process.env.GENAI_ENABLED !== 'false',
  PORT: parseInt(process.env.GENAI_PORT || '8001', 10),
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MS || '1800000', 10),
};
