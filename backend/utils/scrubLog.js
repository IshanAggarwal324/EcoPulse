/**
 * Redact internal topology from log/error strings before they reach stdout or
 * log aggregation (Module 7.3 security hardening).
 *
 * Strips: full URLs, IPv4 addresses (+port), and known internal/EcoPulse
 * hostnames (ai-service, genai-service, mongodb, redis, backend, localhost,
 * and provider hosts like alchemy/infura). Keeps the error *category*
 * (e.g. "ECONNREFUSED") so logs stay useful for diagnosis without leaking
 * internal addresses.
 */
const INTERNAL_HOST_CORE = ['ai-service', 'ai_service', 'genai-service', 'genai_service', 'mongodb', 'mongo', 'redis', 'backend', 'localhost', '127.0.0.1'];

const scrubMessage = (message) => {
  if (message === null || message === undefined) return null;
  let out = String(message);
  out = out.replace(/https?:\/\/[^\s'"<>]+/g, '[url]');
  out = out.replace(/(?<![0-9A-Fa-f:])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '[addr]');
  out = out.replace(/[a-zA-Z0-9.-]+\.(alchemy|infura|eth)\.[a-zA-Z0-9./_-]+/g, '[host]');
  const hostAlt = INTERNAL_HOST_CORE.map((h) => h.replace(/\./g, '\\.')).join('|');
  out = out.replace(new RegExp(`(?:[a-zA-Z0-9-]+\\.)*(${hostAlt})(:\\d+)?\\b`, 'g'), '[host]');
  return out.slice(0, 240);
};

module.exports = { scrubMessage };
