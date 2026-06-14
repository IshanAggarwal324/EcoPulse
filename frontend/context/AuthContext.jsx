import React, {
  createContext, useState, useContext, useEffect, useCallback, useRef, useMemo,
} from 'react';
import { API_BASE } from '../utils/api';

const AuthContext = createContext(null);

const API_URL = API_BASE;
const parseAuthResponse = (data) => (data.data || data);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshPromiseRef = useRef(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  const refreshSession = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });

        const data = await response.json();

        if (!response.ok) {
          clearSession();
          return null;
        }

        const { user: userData, accessToken: newAccessToken } = parseAuthResponse(data);
        setAccessToken(newAccessToken || null);
        if (userData) setUser(userData);

        return true;
      } catch {
        clearSession();
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [clearSession]);

  const fetchCurrentUser = useCallback(async () => {
    const response = await fetch(`${API_URL}/auth/me`, {
      credentials: 'include',
    });

    const data = await response.json();

    if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
      const newToken = await refreshSession();
      if (newToken) return fetchCurrentUser();
      return false;
    }

    if (!response.ok) return false;

    setUser(data.data.user);
    setAccessToken(data.data?.accessToken || null);
    return true;
  }, [refreshSession]);

  useEffect(() => {
    const init = async () => {
      try {
        const ok = await fetchCurrentUser();
        if (!ok) clearSession();
      } catch {
        clearSession();
      } finally {
        setLoading(false);
      }
    };

    init();
    // Run once on mount only; login/register set user directly.
  }, [clearSession, fetchCurrentUser]);

  const login = async (email, password) => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.errors?.join(', ') || data.message || 'Login failed';
        return { success: false, message: msg, errors: data.errors };
      }

      const { user: userData, accessToken: newAccessToken } = parseAuthResponse(data);
      setAccessToken(newAccessToken || null);
      setUser(userData);

      return { success: true };
    } catch (error) {
      return { success: false, message: error.message || 'Network error' };
    }
  };

  const register = async (userData) => {
    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.errors?.join(', ') || data.message || 'Registration failed';
        return { success: false, message: msg, errors: data.errors };
      }

      const { user: newUser, accessToken: newAccessToken } = parseAuthResponse(data);
      if (newUser && newAccessToken) {
        setAccessToken(newAccessToken);
        setUser(newUser);
        return { success: true };
      }

      return {
        success: true,
        requiresLogin: true,
        message: data.message || 'Registration submitted. Please sign in.',
      };
    } catch (error) {
      return { success: false, message: error.message || 'Network error' };
    }
  };

  const updateProfile = async (updates) => {
    try {
      const response = await fetch(`${API_URL}/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
        credentials: 'include',
      });

      const data = await response.json();

      if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
        const newToken = await refreshSession();
        if (newToken) {
          const retry = await fetch(`${API_URL}/auth/profile`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(updates),
            credentials: 'include',
          });
          const retryData = await retry.json();
          if (!retry.ok) {
            return { success: false, message: retryData.message, errors: retryData.errors };
          }
          setUser(retryData.data.user);
          return { success: true, message: retryData.message };
        }
      }

      if (!response.ok) {
        return { success: false, message: data.message, errors: data.errors };
      }

      setUser(data.data.user);
      return { success: true, message: data.message };
    } catch (error) {
      return { success: false, message: error.message };
    }
  };

  const updatePassword = async ({ currentPassword, newPassword }) => {
    try {
      const response = await fetch(`${API_URL}/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword, newPassword }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, message: data.message, errors: data.errors };
      }

      setAccessToken(data.data?.accessToken || null);

      return { success: true, message: data.message };
    } catch (error) {
      return { success: false, message: error.message };
    }
  };

  const logout = async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best-effort server logout.
    } finally {
      clearSession();
    }
  };

  const isAuthenticated = !!user && !!accessToken;

  const value = useMemo(
    () => ({
      user,
      accessToken,
      loading,
      isAuthenticated,
      login,
      register,
      logout,
      updateProfile,
      updatePassword,
      refreshSession,
    }),
    [
      user,
      accessToken,
      loading,
      isAuthenticated,
      login,
      register,
      logout,
      updateProfile,
      updatePassword,
      refreshSession,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
