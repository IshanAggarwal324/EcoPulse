import { useEffect } from 'react';
import { configureApiAuth } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const SessionBridge = () => {
  const { logout, refreshSession } = useAuth();
  const toast = useToast();

  useEffect(() => {
    // API auth is cookie-based (credentials: 'include'); no access token is
    // held in memory or attached as a Bearer header.
    configureApiAuth({
      getAccessToken: () => null,
      refreshSession,
      onSessionExpired: () => {
        toast.error('Your session expired. Please sign in again.');
        logout();
      },
    });
  }, [logout, refreshSession, toast]);

  return null;
};

export default SessionBridge;
