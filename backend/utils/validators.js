const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;

const validateEmail = (email) => {
  if (!email || typeof email !== 'string') return 'Email is required';
  if (!EMAIL_REGEX.test(email.trim())) return 'Please provide a valid email address';
  return null;
};

const validatePassword = (password, { minLength = 6 } = {}) => {
  if (!password) return 'Password is required';
  if (password.length < minLength) return `Password must be at least ${minLength} characters`;
  return null;
};

const validateName = (name) => {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return 'Name is required and must be at least 2 characters';
  }
  if (name.trim().length > 50) return 'Name cannot exceed 50 characters';
  return null;
};

const validateWalletAddress = (address, { required = false } = {}) => {
  if (!address) return required ? 'Wallet address is required' : null;
  if (!WALLET_REGEX.test(address.trim())) {
    return 'Wallet address must be a valid Ethereum address (0x...)';
  }
  return null;
};

const collectErrors = (checks) => {
  const errors = checks.filter(Boolean);
  return errors.length ? errors : null;
};

module.exports = {
  validateEmail,
  validatePassword,
  validateName,
  validateWalletAddress,
  collectErrors,
  EMAIL_REGEX,
  WALLET_REGEX,
};
