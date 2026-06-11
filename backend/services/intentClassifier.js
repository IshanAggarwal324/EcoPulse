const PERIOD_PATTERNS = [
  { pattern: /\b(7\s*days?|this\s*week|past\s*week|last\s*week|next\s*week|weekly)\b/i, period: '7d' },
  { pattern: /\b(14\s*days?|fortnight|biweekly|past\s*fortnight|last\s*fortnight|2\s*weeks?)\b/i, period: '14d' },
  { pattern: /\b(30\s*days?|this\s*month|past\s*month|last\s*month|next\s*month|monthly)\b/i, period: '30d' },
];

function detectPeriodFromMessage(message) {
  if (!message || typeof message !== 'string') return null;

  for (const { pattern, period } of PERIOD_PATTERNS) {
    if (pattern.test(message)) return period;
  }

  return null;
}

const GRID_ENERGY_PATTERN = /\b(energ(?:y|ies)|generat(?:e|ed|ion)|consum(?:e|ed|ption)|kwh|kilowatt|grid\s*(?:output|supply|power)|power\s*(?:output|supply)|electricity)\b/i;

const WALLET_PROFIT_PATTERN = /\b(profit|earn(?:ed|ings?)|spent|spend|sales?|bought|purchas(?:e|ed)|revenue|income|net\s*flow|wallet\s*(?:balance|activity|flow)|credits?\s*(?:received|spent|earned))\b/i;

const CARBON_PATTERN = /\b(carbon|cc|credits?\s*balance|emission|offset|greenhouse|co2|sustainability)\b/i;

const TRADES_PATTERN = /\b(trad(?:e|ed|es|ing)|market(?:place)?|volume|list(?:ing|ed)?|buy|sell|order|transaction|deal)\b/i;

const FORECAST_PATTERN = /\b(forecast|predict(?:ion)?|future|outlook|trend|upcoming|next\s*(?:week|month|days?)|expected|projection)\b/i;

const NODES_PATTERN = /\b(node|nodes|solar|wind|turbine|panel|active\s*node|status|capacity|farm)\b/i;

function matchGridEnergyIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return GRID_ENERGY_PATTERN.test(message);
}

function matchWalletProfitIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return WALLET_PROFIT_PATTERN.test(message);
}

function matchCarbonIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return CARBON_PATTERN.test(message);
}

function matchTradesIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return TRADES_PATTERN.test(message);
}

function matchForecastIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return FORECAST_PATTERN.test(message);
}

function matchNodesIntent(message) {
  if (!message || typeof message !== 'string') return false;
  return NODES_PATTERN.test(message);
}

const INTENT_MATCHERS = [
  { intent: 'wallet_profit', matcher: matchWalletProfitIntent },
  { intent: 'carbon', matcher: matchCarbonIntent },
  { intent: 'forecast', matcher: matchForecastIntent },
  { intent: 'trades', matcher: matchTradesIntent },
  { intent: 'nodes', matcher: matchNodesIntent },
  { intent: 'grid_energy', matcher: matchGridEnergyIntent },
];

function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return { intent: 'general', period: null };
  }

  for (const { intent, matcher } of INTENT_MATCHERS) {
    if (matcher(message)) {
      return { intent, period: detectPeriodFromMessage(message) };
    }
  }

  return { intent: 'general', period: detectPeriodFromMessage(message) };
}

module.exports = {
  detectPeriodFromMessage,
  matchGridEnergyIntent,
  matchWalletProfitIntent,
  matchCarbonIntent,
  matchTradesIntent,
  matchForecastIntent,
  matchNodesIntent,
  classifyIntent,
};
