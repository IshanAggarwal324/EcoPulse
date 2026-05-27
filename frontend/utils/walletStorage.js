const SESSION_ACCOUNT_KEY = 'ecopulse_wallet_account';
const SESSION_CONNECTED_KEY = 'ecopulse_wallet_was_connected';

export const saveWalletSession = (account) => {
  if (!account) return;
  sessionStorage.setItem(SESSION_ACCOUNT_KEY, account);
  sessionStorage.setItem(SESSION_CONNECTED_KEY, 'true');
};

export const clearWalletSession = () => {
  sessionStorage.removeItem(SESSION_ACCOUNT_KEY);
  sessionStorage.removeItem(SESSION_CONNECTED_KEY);
};

export const getLastWalletAccount = () =>
  sessionStorage.getItem(SESSION_ACCOUNT_KEY);

export const hadWalletSession = () =>
  sessionStorage.getItem(SESSION_CONNECTED_KEY) === 'true';
