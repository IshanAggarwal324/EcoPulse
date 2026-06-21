import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  getProvider,
  getCarbonCreditBalance,
  ensureCorrectNetwork,
  EXPECTED_CHAIN_ID,
  subscribeCarbonCreditTransfers,
} from '../utils/blockchain';
import {
  saveWalletSession,
  clearWalletSession,
  getLastWalletAccount,
  hadWalletSession,
} from '../utils/walletStorage';
import { logClientError } from '../utils/clientLogger';

const WalletStateContext = createContext(null);
const WalletActionsContext = createContext(null);

// TODO(L7): Wagmi / RainbowKit for WalletConnect + hardware wallet support.
// See P2P_Trading_Production_Readiness.md §2 — Enhanced Wallet Connection.
const PROVIDER_POLL_MS = 2000;
const RECONNECT_DEBOUNCE_MS = 300;

export const WalletProvider = ({ children }) => {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [balance, setBalance] = useState('0');
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const [hadPreviousSession, setHadPreviousSession] = useState(false);

  const mountedRef = useRef(true);
  const reconnectTimerRef = useRef(null);
  const providerPollRef = useRef(null);

  const refreshBalance = useCallback(async (address = account) => {
    if (!address) {
      if (mountedRef.current) setBalance('0');
      return;
    }
    const bal = await getCarbonCreditBalance(address);
    if (mountedRef.current) setBalance(bal);
  }, [account]);

  const applyConnectedAccount = useCallback(async (address, network) => {
    if (!mountedRef.current || !address) return false;

    setAccount(address);
    setChainId(network ? Number(network.chainId) : null);
    setStatus('connected');
    setError(null);
    saveWalletSession(address);
    setHadPreviousSession(true);

    const bal = await getCarbonCreditBalance(address);
    if (mountedRef.current) setBalance(bal);
    return true;
  }, []);

  const syncFromProvider = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !mountedRef.current) return false;

    try {
      const accounts = await provider.send('eth_accounts', []);
      const network = await provider.getNetwork();

      if (!mountedRef.current) return false;

      if (accounts.length > 0) {
        await applyConnectedAccount(accounts[0], network);
        return true;
      }

      setAccount(null);
      setBalance('0');
      setChainId(Number(network.chainId));
      setStatus(hadWalletSession() ? 'disconnected' : 'disconnected');
      return false;
    } catch (err) {
      logClientError('WalletContext', err, { phase: 'syncFromProvider' });
      if (mountedRef.current) {
        setError(err.message || 'Failed to sync wallet');
      }
      return false;
    }
  }, [applyConnectedAccount]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setBalance('0');
    setError(null);
    setStatus('disconnected');
    clearWalletSession();
    setHadPreviousSession(false);
  }, []);

  /**
   * Silent reconnect via eth_accounts (no MetaMask popup).
   */
  const reconnectSilent = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return false;

    setStatus('reconnecting');
    setError(null);

    const ok = await syncFromProvider();
    if (mountedRef.current && !ok) {
      setStatus('disconnected');
    }
    return ok;
  }, [syncFromProvider]);

  /**
   * Reconnect after refresh or provider restore. Tries silent first, then
   * eth_requestAccounts when a prior session exists.
   */
  const reconnect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      const message = 'MetaMask is not installed. Please install it to use this app.';
      setError(message);
      throw new Error(message);
    }

    setStatus('reconnecting');
    setError(null);

    try {
      const silentOk = await syncFromProvider();
      if (silentOk) return true;

      if (!hadWalletSession() && !getLastWalletAccount()) {
        setStatus('disconnected');
        return false;
      }

      await ensureCorrectNetwork();
      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts.length > 0) {
        const network = await provider.getNetwork();
        await applyConnectedAccount(accounts[0], network);
        return true;
      }

      setStatus('disconnected');
      return false;
    } catch (err) {
      const message = err.message || 'Failed to reconnect wallet.';
      if (mountedRef.current) {
        setError(message);
        setStatus('disconnected');
      }
      throw err;
    }
  }, [syncFromProvider, applyConnectedAccount]);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error('MetaMask is not installed. Please install it to use this app.');
      }

      await ensureCorrectNetwork();

      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts.length > 0) {
        const network = await provider.getNetwork();
        await applyConnectedAccount(accounts[0], network);
        return accounts[0];
      }

      setStatus('disconnected');
      return null;
    } catch (err) {
      const message = err.message || 'Failed to connect wallet.';
      if (mountedRef.current) {
        setError(message);
        setStatus('disconnected');
      }
      throw err;
    }
  }, [applyConnectedAccount]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (!hadWalletSession() && !getLastWalletAccount()) return;
      reconnectSilent();
    }, RECONNECT_DEBOUNCE_MS);
  }, [reconnectSilent]);

  const attachEthereumListeners = useCallback((ethereum) => {
    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        setAccount(null);
        setBalance('0');
        setStatus('disconnected');
        clearWalletSession();
        setHadPreviousSession(false);
        return;
      }
      applyConnectedAccount(accounts[0]);
    };

    const handleChainChanged = () => {
      scheduleReconnect();
    };

    const handleConnect = () => {
      scheduleReconnect();
    };

    const handleDisconnect = () => {
      setAccount(null);
      setBalance('0');
      setStatus('disconnected');
    };

    ethereum.on('accountsChanged', handleAccountsChanged);
    ethereum.on('chainChanged', handleChainChanged);
    ethereum.on('connect', handleConnect);
    ethereum.on('disconnect', handleDisconnect);

    return () => {
      ethereum.removeListener?.('accountsChanged', handleAccountsChanged);
      ethereum.removeListener?.('chainChanged', handleChainChanged);
      ethereum.removeListener?.('connect', handleConnect);
      ethereum.removeListener?.('disconnect', handleDisconnect);
    };
  }, [applyConnectedAccount, scheduleReconnect]);

  useEffect(() => {
    mountedRef.current = true;
    setHadPreviousSession(hadWalletSession());

    let detachEthereum = () => {};

    const initWallet = async () => {
      if (hadWalletSession() || getLastWalletAccount()) {
        await reconnectSilent();
      } else {
        await syncFromProvider();
      }
    };

    const setupProvider = () => {
      const ethereum = window.ethereum;
      if (ethereum?.on) {
        detachEthereum = attachEthereumListeners(ethereum);
      }
      initWallet();
    };

    if (window.ethereum) {
      setupProvider();
    } else {
      providerPollRef.current = setInterval(() => {
        if (window.ethereum) {
          clearInterval(providerPollRef.current);
          providerPollRef.current = null;
          setupProvider();
        }
      }, PROVIDER_POLL_MS);
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        scheduleReconnect();
      }
    };

    const handleWindowFocus = () => {
      scheduleReconnect();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (providerPollRef.current) clearInterval(providerPollRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleWindowFocus);
      detachEthereum();
    };
  }, [
    attachEthereumListeners,
    reconnectSilent,
    syncFromProvider,
    scheduleReconnect,
  ]);

  useEffect(() => {
    if (!account) return undefined;

    const unsubscribe = subscribeCarbonCreditTransfers(account, () => {
      refreshBalance(account);
    });

    return unsubscribe;
  }, [account, refreshBalance]);

  const connecting = status === 'connecting' || status === 'reconnecting';
  const reconnecting = status === 'reconnecting';
  const isCorrectNetwork =
    chainId === null || chainId === EXPECTED_CHAIN_ID;

  const stateValue = useMemo(
    () => ({
      account,
      chainId,
      balance,
      status,
      connecting,
      reconnecting,
      error,
      isCorrectNetwork,
      expectedChainId: EXPECTED_CHAIN_ID,
      hadPreviousSession,
    }),
    [
      account,
      chainId,
      balance,
      status,
      connecting,
      reconnecting,
      error,
      isCorrectNetwork,
      hadPreviousSession,
    ],
  );

  const actionsValue = useMemo(
    () => ({
      connect,
      disconnect,
      reconnect,
      reconnectSilent,
      refreshBalance,
      ensureNetwork: ensureCorrectNetwork,
    }),
    [connect, disconnect, reconnect, reconnectSilent, refreshBalance],
  );

  return (
    <WalletActionsContext.Provider value={actionsValue}>
      <WalletStateContext.Provider value={stateValue}>
        {children}
      </WalletStateContext.Provider>
    </WalletActionsContext.Provider>
  );
};

export const useWalletState = () => {
  const ctx = useContext(WalletStateContext);
  if (!ctx) {
    throw new Error('useWalletState must be used within a WalletProvider');
  }
  return ctx;
};

export const useWalletActions = () => {
  const ctx = useContext(WalletActionsContext);
  if (!ctx) {
    throw new Error('useWalletActions must be used within a WalletProvider');
  }
  return ctx;
};

export const useWallet = () => ({
  ...useWalletState(),
  ...useWalletActions(),
});

export default WalletStateContext;
