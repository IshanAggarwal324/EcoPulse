import { getAddress } from 'ethers';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const validateEmail = (email) => {
  if (!email?.trim()) return 'Email is required';
  if (!EMAIL_REGEX.test(email.trim())) return 'Please enter a valid email address';
  return '';
};

export const validatePassword = (password, minLength = 6) => {
  if (!password) return 'Password is required';
  if (password.length < minLength) return `Password must be at least ${minLength} characters`;
  return '';
};

export const validatePasswordStrength = (password) => {
  const base = validatePassword(password, 8);
  if (base) return base;
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Include at least one number';
  return '';
};

export const validateName = (name) => {
  if (!name?.trim()) return 'Name is required';
  if (name.trim().length < 2) return 'Name must be at least 2 characters';
  if (name.trim().length > 50) return 'Name cannot exceed 50 characters';
  return '';
};

export const validateConfirmPassword = (password, confirmPassword) => {
  if (!confirmPassword) return 'Please confirm your password';
  if (password !== confirmPassword) return 'Passwords do not match';
  return '';
};

export const validateWalletAddress = (address, required = false) => {
  if (!address?.trim()) return required ? 'Wallet address is required' : '';
  const trimmed = address.trim();
  // Fast structural pre-check before the heavier EIP-55 checksum verification.
  if (!WALLET_REGEX.test(trimmed)) {
    return 'Enter a valid Ethereum address (0x + 40 hex characters)';
  }
  try {
    // getAddress throws if the address is malformed or fails the EIP-55 checksum.
    getAddress(trimmed);
  } catch {
    return 'Enter a valid checksummed Ethereum address';
  }
  return '';
};

// True when the address has no mixed case (checksum cannot be visually verified).
// All-lower or all-upper hex after the 0x prefix means EIP-55 casing is absent.
export const isAddressChecksumAmbiguous = (address) => {
  const trimmed = (address || '').trim();
  if (!WALLET_REGEX.test(trimmed)) return false;
  const body = trimmed.slice(2);
  return body === body.toLowerCase() || body === body.toUpperCase();
};

export const validateLoginForm = ({ email, password }) => {
  const errors = {};
  const emailErr = validateEmail(email);
  const passErr = validatePassword(password);
  if (emailErr) errors.email = emailErr;
  if (passErr) errors.password = passErr;
  return errors;
};

export const validateRegisterForm = ({ name, email, password, confirmPassword, walletAddress }) => {
  const errors = {};
  const nameErr = validateName(name);
  const emailErr = validateEmail(email);
  const passErr = validatePassword(password);
  const confirmErr = validateConfirmPassword(password, confirmPassword);
  const walletErr = validateWalletAddress(walletAddress);

  if (nameErr) errors.name = nameErr;
  if (emailErr) errors.email = emailErr;
  if (passErr) errors.password = passErr;
  if (confirmErr) errors.confirmPassword = confirmErr;
  if (walletErr) errors.walletAddress = walletErr;

  return errors;
};

export const hasErrors = (errors) => Object.keys(errors).length > 0;
