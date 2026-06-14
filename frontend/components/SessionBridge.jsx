import { useEffect } from 'react';
import { configureApiAuth } from '../utils/api';
import { configureSocketAuth } from '../utils/socketClient';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const SessionBridge = () => {
  const { accessToken, logout, refreshSession } = useAuth();
  const toast = useToast();

  useEffect(() => {
    configureApiAuth({
      getAccessToken: () => accessToken,
      refreshSession,
      onSessionExpired: () => {
        toast.error('Your session expired. Please sign in again.');
        logout();
      },
    });

    configureSocketAuth(() => accessToken);
  }, [accessToken, logout, refreshSession, toast]);

  return null;
};

export default SessionBridge;
