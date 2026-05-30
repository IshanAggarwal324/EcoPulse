import React, {
  createContext, useState, useContext, useEffect, useCallback, useRef, useMemo,
} from 'react';

const AuthContext = createContext(null);

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api/v1';
const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';

const parseAuthResponse = (data) => {
  const payload = data.data || data;
  const accessToken = payload.accessToken || payload.token;
  const refreshToken = payload.refreshToken;
  const user = payload.user;
  return { accessToken, refreshToken, user };
};

const migrateLegacyToken = () => {
  const legacy = localStorage.getItem('token');
  if (legacy && !localStorage.getItem(ACCESS_KEY)) {
    localStorage.setItem(ACCESS_KEY, legacy);
    localStorage.removeItem('token');
  }
};

migrateLegacyToken();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(localStorage.getItem(ACCESS_KEY) || null);
  const [refreshToken, setRefreshToken] = useState(localStorage.getItem(REFRESH_KEY) || null);
  const [loading, setLoading] = useState(true);
  const refreshPromiseRef = useRef(null);

  const persistTokens = useCallback((access, refresh) => {
    if (access) {
      localStorage.setItem(ACCESS_KEY, access);
      setAccessToken(access);
    }
    if (refresh) {
      localStorage.setItem(REFRESH_KEY, refresh);
      setRefreshToken(refresh);
    }
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  const refreshSession = useCallback(async () => {
    const storedRefresh = localStorage.getItem(REFRESH_KEY);
    if (!storedRefresh) return null;

    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: storedRefresh }),
        });

        const data = await response.json();

        if (!response.ok) {
          clearSession();
          return null;
        }

        const { accessToken: newAccess, refreshToken: newRefresh, user: userData } =
          parseAuthResponse(data);

        persistTokens(newAccess, newRefresh || storedRefresh);
        if (userData) setUser(userData);

        return newAccess;
      } catch {
        clearSession();
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [clearSession, persistTokens]);

  const fetchCurrentUser = useCallback(async (token) => {
    const response = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();

    if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
      const newToken = await refreshSession();
      if (newToken) return fetchCurrentUser(newToken);
      return false;
    }

    if (!response.ok) return false;

    setUser(data.data.user);
    return true;
  }, [refreshSession]);

  useEffect(() => {
    const init = async () => {
      if (!accessToken) {
        setLoading(false);
        return;
      }

      const ok = await fetchCurrentUser(accessToken);
      if (!ok) clearSession();
      setLoading(false);
    };

    init();
  }, []);

  const login = async (email, password) => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.errors?.join(', ') || data.message || 'Login failed';
        return { success: false, message: msg, errors: data.errors };
      }

      const { accessToken: access, refreshToken: refresh, user: userData } = parseAuthResponse(data);
      persistTokens(access, refresh);
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
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.errors?.join(', ') || data.message || 'Registration failed';
        return { success: false, message: msg, errors: data.errors };
      }

      const { accessToken: access, refreshToken: refresh, user: newUser } = parseAuthResponse(data);
      persistTokens(access, refresh);
      setUser(newUser);

      return { success: true };
    } catch (error) {
      return { success: false, message: error.message || 'Network error' };
    }
  };

  const updateProfile = async (updates) => {
    try {
      const token = localStorage.getItem(ACCESS_KEY);
      const response = await fetch(`${API_URL}/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });

      const data = await response.json();

      if (response.status === 401 && data.code === 'TOKEN_EXPIRED') {
        const newToken = await refreshSession();
        if (newToken) {
          const retry = await fetch(`${API_URL}/auth/profile`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${newToken}`,
            },
            body: JSON.stringify(updates),
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
      const token = localStorage.getItem(ACCESS_KEY);
      const response = await fetch(`${API_URL}/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, message: data.message, errors: data.errors };
      }

      const { accessToken: access, refreshToken: refresh } = parseAuthResponse(data);
      if (access) persistTokens(access, refresh);

      return { success: true, message: data.message };
    } catch (error) {
      return { success: false, message: error.message };
    }
  };

  const logout = () => clearSession();

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
