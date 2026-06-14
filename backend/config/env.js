const DEFAULT_HARDHAT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const hasBlockchainConfig = () =>
  Boolean(process.env.RPC_URL || process.env.CARBON_CREDIT_ADDRESS || process.env.ENERGY_TRADING_ADDRESS);

const validateEnvironment = () => {
  const issues = [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    issues.push('JWT_SECRET must be set and at least 32 characters');
  }

  if (isProduction) {
    if (!process.env.MONGO_URI) {
      issues.push('MONGO_URI must be set in production');
    }

    const corsOrigins = parseList(process.env.CORS_ORIGIN || process.env.FRONTEND_URL);
    if (corsOrigins.length === 0) {
      issues.push('CORS_ORIGIN (or FRONTEND_URL) must be set in production');
    }

    if (hasBlockchainConfig()) {
      if (!process.env.RPC_URL) issues.push('RPC_URL must be set when blockchain sync is enabled');
      if (!process.env.CARBON_CREDIT_ADDRESS) issues.push('CARBON_CREDIT_ADDRESS must be set when blockchain sync is enabled');
      if (!process.env.ENERGY_TRADING_ADDRESS) issues.push('ENERGY_TRADING_ADDRESS must be set when blockchain sync is enabled');
      if (!process.env.PRIVATE_KEY) {
        issues.push('PRIVATE_KEY must be set when blockchain sync is enabled');
      } else if (process.env.PRIVATE_KEY === DEFAULT_HARDHAT_PRIVATE_KEY) {
        issues.push('PRIVATE_KEY cannot use the Hardhat default account in production');
      }
    }

    if (!process.env.INTERNAL_SERVICE_API_KEY) {
      issues.push('INTERNAL_SERVICE_API_KEY must be set in production');
    }
  }

  if (issues.length > 0) {
    const message = issues.map((issue) => `- ${issue}`).join('\n');
    throw new Error(`Environment validation failed:\n${message}`);
  }
};

module.exports = {
  validateEnvironment,
  DEFAULT_HARDHAT_PRIVATE_KEY,
};
