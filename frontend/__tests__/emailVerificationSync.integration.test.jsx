import React from 'react';
import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import VerifyEmail from '../pages/VerifyEmail';
import EmailVerificationBanner from '../components/EmailVerificationBanner';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ToastProvider } from '../context/ToastContext';
import { authApi } from '../utils/api';

// ---------------------------------------------------------------------------
// email-verification-banner-sync bugfix spec — task 4 (integration tests).
// Runs against the FIXED code from task 3, exercising the full flow rather
// than individual units: verifying via the /verify-email route, syncing
// across two independent AuthProvider "windows", and confirming existing
// non-verification flows (resend / malformed token) remain regression-free.
// ---------------------------------------------------------------------------

vi.mock('../utils/api', () => ({
  authApi: {
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    updateProfile: vi.fn(),
    updatePassword: vi.fn(),
    logout: vi.fn(),
  },
  API_BASE: 'http://test.local/api/v1',
  ApiError: class ApiError extends Error {},
}));

const EMAIL_VERIFIED_SYNC_KEY = 'ecopulse.auth.emailVerifiedAt';

function DashboardStub() {
  return (
    <div>
      <EmailVerificationBanner />
      <span>Dashboard</span>
    </div>
  );
}

function makeFetchMock(getVerified) {
  return vi.fn(async (url) => {
    if (String(url).endsWith('/auth/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { user: { id: 'u1', email: 'a@a.com', isEmailVerified: getVerified() } },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('Email verification sync — integration (fixed code)', () => {
  beforeEach(() => {
    authApi.verifyEmail.mockReset();
    authApi.resendVerification.mockReset();
    window.localStorage.clear();
  });

  test('full flow: /verify-email?token=... succeeds, user.isEmailVerified becomes true, dashboard shows no banner, no reload', async () => {
    let verified = false;
    global.fetch = makeFetchMock(() => verified);
    authApi.verifyEmail.mockImplementation(async () => {
      verified = true;
      return { message: 'Email verified successfully.' };
    });

    let ctx;
    function Capture() {
      ctx = useAuth();
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/verify-email?token=good-token']}>
        <ToastProvider>
          <AuthProvider>
            <Capture />
            <Routes>
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route path="/" element={<DashboardStub />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Email verified')).toBeInTheDocument();

    await waitFor(() => expect(ctx.user?.isEmailVerified).toBe(true));

    // Follow the "Continue to dashboard" link (client-side nav, no reload).
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /continue to dashboard/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Verify your email address')).not.toBeInTheDocument();
  });

  test('two-window flow: window A verifies, window B (dashboard open) loses its banner once the storage signal is delivered', async () => {
    let verified = false;
    global.fetch = makeFetchMock(() => verified);
    authApi.verifyEmail.mockImplementation(async () => {
      verified = true;
      return { message: 'Email verified successfully.' };
    });

    // Window B: dashboard already open, showing the banner.
    render(
      <ToastProvider>
        <AuthProvider>
          <DashboardStub />
        </AuthProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText('Verify your email address')).toBeInTheDocument();

    // Window A: independent AuthProvider completing verification via the
    // real VerifyEmail.jsx success path.
    render(
      <MemoryRouter initialEntries={['/verify-email?token=good-token']}>
        <ToastProvider>
          <AuthProvider>
            <VerifyEmail />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Email verified');

    // Real browsers deliver `storage` events to window B automatically;
    // jsdom (single window) requires manually dispatching what the browser
    // would deliver, using the real value VerifyEmail.jsx's fixed code wrote.
    await waitFor(() => {
      expect(window.localStorage.getItem(EMAIL_VERIFIED_SYNC_KEY)).toBeTruthy();
    });
    window.dispatchEvent(new window.StorageEvent('storage', {
      key: EMAIL_VERIFIED_SYNC_KEY,
      newValue: window.localStorage.getItem(EMAIL_VERIFIED_SYNC_KEY),
    }));

    await waitFor(() => {
      expect(screen.queryByText('Verify your email address')).not.toBeInTheDocument();
    });
  });

  test('regression flow: resend-email keeps the banner and user unchanged; malformed token keeps the same result', async () => {
    let verified = false;
    global.fetch = makeFetchMock(() => verified);
    authApi.resendVerification.mockResolvedValue({ status: 'sent', message: 'Sent!' });

    let ctx;
    function Capture() {
      ctx = useAuth();
      return null;
    }

    render(
      <ToastProvider>
        <AuthProvider>
          <Capture />
          <DashboardStub />
        </AuthProvider>
      </ToastProvider>,
    );
    await screen.findByText('Verify your email address');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend email/i }));
    await waitFor(() => expect(authApi.resendVerification).toHaveBeenCalledTimes(1));

    expect(screen.getByText('Verify your email address')).toBeInTheDocument();
    expect(ctx.user?.isEmailVerified).toBe(false);

    // Malformed/missing-token verification link, in a separate window.
    authApi.verifyEmail.mockReset();
    render(
      <MemoryRouter initialEntries={['/verify-email']}>
        <ToastProvider>
          <AuthProvider>
            <VerifyEmail />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Invalid verification link')).toBeInTheDocument();
    expect(authApi.verifyEmail).not.toHaveBeenCalled();
  });
});
