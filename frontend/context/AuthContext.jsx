import React, {
  createContext, useState, useContext, useEffect, useCallback, useRef, useMemo,
} from 'react';
import { API_BASE, authApi, ApiError } from '../utils/api';
import { hasPermission as userHasPermission, hasRole as userHasRole } from '../utils/permissions';

const AuthContext = createContext(null);

const API_URL = API_BASE;
const parseAuthResponse = (data) => (data.data || data);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshPromiseRef = useRef(null);

  const clearSession = useCallback(() => {
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

        // Auth is cookie-based; the new access token is set as an httpOnly
        // cookie by the server, so we only need the user payload here.
        const { user: userData } = parseAuthResponse(data);
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

      const { user: userData } = parseAuthResponse(data);
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
        return { success: false, message: msg, errors: data.errors, code: data.code || null };
      }

      const { user: newUser } = parseAuthResponse(data);
      if (newUser) {
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
      const data = await authApi.updateProfile(updates);
      setUser(data.data.user);
      return { success: true, message: data.message };
    } catch (error) {
      if (error instanceof ApiError) {
        return { success: false, message: error.message, errors: error.details?.errors };
      }
      return { success: false, message: error.message || 'Network error' };
    }
  };

  const updatePassword = async ({ currentPassword, newPassword }) => {
    try {
      const data = await authApi.updatePassword({ currentPassword, newPassword });
      return { success: true, message: data.message };
    } catch (error) {
      if (error instanceof ApiError) {
        return { success: false, message: error.message, errors: error.details?.errors };
      }
      return { success: false, message: error.message || 'Network error' };
    }
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Best-effort server logout.
    } finally {
      clearSession();
    }
  };

  const isAuthenticated = !!user;

  // Module 8.2 — role/permission helpers bound to the current user, for
  // client-side UI gating. (Server still enforces every authorization.)
  const hasPermission = useCallback((permission) => userHasPermission(user, permission), [user]);
  const hasRole = useCallback((role) => userHasRole(user, role), [user]);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated,
      hasPermission,
      hasRole,
      login,
      register,
      logout,
      updateProfile,
      updatePassword,
      refreshSession,
    }),
    [
      user,
      loading,
      isAuthenticated,
      hasPermission,
      hasRole,
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
