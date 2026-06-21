const isProduction = () => process.env.NODE_ENV === 'production';

const hasBlockchainConfig = () =>
  Boolean(process.env.RPC_URL || process.env.CARBON_CREDIT_ADDRESS || process.env.ENERGY_TRADING_ADDRESS);

/**
 * Resolve a service URL — localhost defaults are allowed only outside production.
 */
const resolveServiceUrl = (envVar, devDefault, { requiredInProduction = true, label = envVar } = {}) => {
  const value = String(process.env[envVar] || '').trim();
  if (value) return value;

  if (isProduction() && requiredInProduction) {
    throw new Error(`${envVar} must be set in production (${label})`);
  }

  return devDefault;
};

const getAiServiceUrl = () =>
  resolveServiceUrl('AI_SERVICE_URL', 'http://localhost:8000', {
    label: 'AI forecasting microservice',
  });

const getGenaiServiceUrl = () =>
  resolveServiceUrl('GENAI_SERVICE_URL', 'http://localhost:8001', {
    label: 'GenAI microservice',
  });

const getRpcUrl = () => {
  const value = String(process.env.RPC_URL || '').trim();
  if (value) return value;

  if (isProduction() && hasBlockchainConfig()) {
    throw new Error('RPC_URL must be set in production when blockchain features are enabled');
  }

  return 'http://127.0.0.1:8545';
};

module.exports = {
  getAiServiceUrl,
  getGenaiServiceUrl,
  getRpcUrl,
  resolveServiceUrl,
  hasBlockchainConfig,
};
