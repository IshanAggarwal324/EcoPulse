const PERIOD_PATTERNS = [
  { pattern: /\b(7\s*days?|this\s*week|past\s*week|last\s*week|weekly)\b/i, period: '7d' },
  { pattern: /\b(14\s*days?|fortnight|biweekly|past\s*fortnight|last\s*fortnight|2\s*weeks?)\b/i, period: '14d' },
  { pattern: /\b(30\s*days?|this\s*month|past\s*month|last\s*month|monthly)\b/i, period: '30d' },
];

function detectPeriodFromMessage(message) {
  if (!message || typeof message !== 'string') return null;

  for (const { pattern, period } of PERIOD_PATTERNS) {
    if (pattern.test(message)) return period;
  }

  return null;
}

module.exports = { detectPeriodFromMessage };
