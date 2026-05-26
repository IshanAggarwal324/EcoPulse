import React, {
  createContext,
  useState,
  useContext,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import {
  getProvider,
  getCarbonCreditBalance,
  ensureCorrectNetwork,
  EXPECTED_CHAIN_ID,
  subscribeCarbonCreditTransfers,
} from '../utils/blockchain';

const WalletContext = createContext(null);

export const WalletProvider = ({ children }) => {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [balance, setBalance] = useState('0');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const refreshBalance = useCallback(async (address = account) => {
    if (!address) {
      setBalance('0');
      return;
    }
    const bal = await getCarbonCreditBalance(address);
    if (mountedRef.current) setBalance(bal);
  }, [account]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setBalance('0');
    setError(null);
  }, []);

  const syncFromProvider = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !mountedRef.current) return;

    try {
      const accounts = await provider.send('eth_accounts', []);
      const network = await provider.getNetwork();
      if (!mountedRef.current) return;

      setChainId(Number(network.chainId));

      if (accounts.length > 0) {
        setAccount(accounts[0]);
        const bal = await getCarbonCreditBalance(accounts[0]);
        if (mountedRef.current) setBalance(bal);
      } else {
        setAccount(null);
        setBalance('0');
      }
    } catch (err) {
      console.error('Wallet sync failed:', err);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
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
        setAccount(accounts[0]);
        setChainId(Number(network.chainId));
        await refreshBalance(accounts[0]);
      }
    } catch (err) {
      const message = err.message || 'Failed to connect wallet.';
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [refreshBalance]);

  useEffect(() => {
    mountedRef.current = true;
    syncFromProvider();

    const ethereum = window.ethereum;
    if (!ethereum?.on) {
      return () => {
        mountedRef.current = false;
      };
    }

    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        disconnect();
        return;
      }
      setAccount(accounts[0]);
      refreshBalance(accounts[0]);
    };

    const handleChainChanged = (hexChainId) => {
      setChainId(parseInt(hexChainId, 16));
      syncFromProvider();
    };

    const handleDisconnect = () => {
      disconnect();
    };

    ethereum.on('accountsChanged', handleAccountsChanged);
    ethereum.on('chainChanged', handleChainChanged);
    ethereum.on('disconnect', handleDisconnect);

    return () => {
      mountedRef.current = false;
      ethereum.removeListener?.('accountsChanged', handleAccountsChanged);
      ethereum.removeListener?.('chainChanged', handleChainChanged);
      ethereum.removeListener?.('disconnect', handleDisconnect);
    };
  }, [syncFromProvider, disconnect, refreshBalance]);

  useEffect(() => {
    if (!account) return undefined;

    const unsubscribe = subscribeCarbonCreditTransfers(account, () => {
      refreshBalance(account);
    });

    return unsubscribe;
  }, [account, refreshBalance]);

  const isCorrectNetwork =
    chainId === null || chainId === EXPECTED_CHAIN_ID;

  const value = {
    account,
    chainId,
    balance,
    connecting,
    error,
    isCorrectNetwork,
    expectedChainId: EXPECTED_CHAIN_ID,
    connect,
    disconnect,
    refreshBalance,
    ensureNetwork: ensureCorrectNetwork,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
};

export const useWallet = () => {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return ctx;
};

export default WalletContext;
