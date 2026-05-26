import { useEffect } from 'react';
import { configureApiAuth } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const SessionBridge = () => {
  const { logout, refreshSession } = useAuth();
  const toast = useToast();

  useEffect(() => {
    configureApiAuth({
      getAccessToken: () => localStorage.getItem('accessToken'),
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
