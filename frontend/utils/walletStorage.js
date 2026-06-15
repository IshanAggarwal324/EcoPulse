const SESSION_ACCOUNT_KEY = 'ecopulse_wallet_account';
const SESSION_CONNECTED_KEY = 'ecopulse_wallet_was_connected';
const SESSION_EXPIRES_KEY = 'ecopulse_wallet_expires_at';

/** Wallet session TTL — cleared when the browser tab/session ends or after this duration. */
export const WALLET_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const isExpired = () => {
  const expiresAt = Number(sessionStorage.getItem(SESSION_EXPIRES_KEY));
  return !expiresAt || Date.now() > expiresAt;
};

export const saveWalletSession = (account) => {
  if (!account) return;
  const expiresAt = Date.now() + WALLET_SESSION_TTL_MS;
  sessionStorage.setItem(SESSION_ACCOUNT_KEY, account);
  sessionStorage.setItem(SESSION_CONNECTED_KEY, 'true');
  sessionStorage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
};

export const clearWalletSession = () => {
  sessionStorage.removeItem(SESSION_ACCOUNT_KEY);
  sessionStorage.removeItem(SESSION_CONNECTED_KEY);
  sessionStorage.removeItem(SESSION_EXPIRES_KEY);
};

export const getLastWalletAccount = () => {
  if (isExpired()) {
    clearWalletSession();
    return null;
  }
  return sessionStorage.getItem(SESSION_ACCOUNT_KEY);
};

export const hadWalletSession = () => {
  if (isExpired()) {
    clearWalletSession();
    return false;
  }
  return sessionStorage.getItem(SESSION_CONNECTED_KEY) === 'true';
};

export const getWalletSessionExpiresAt = () => {
  const expiresAt = Number(sessionStorage.getItem(SESSION_EXPIRES_KEY));
  return Number.isFinite(expiresAt) ? expiresAt : null;
};
