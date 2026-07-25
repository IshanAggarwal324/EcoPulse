import React from 'react';
import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailVerificationBanner from '../EmailVerificationBanner';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { ToastProvider } from '../../context/ToastContext';
import { authApi } from '../../utils/api';

// ---------------------------------------------------------------------------
// email-verification-banner-sync bugfix spec — task 2 (Property 2:
// Preservation). These observe the CURRENT (unfixed) behavior of
// EmailVerificationBanner and pin it down as the baseline that must survive
// the fix untouched — this component is explicitly NOT modified by the fix
// (design.md: "No changes required").
// ---------------------------------------------------------------------------

vi.mock('../../utils/api', () => ({
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

function makeFetchMock(isEmailVerified) {
  return vi.fn(async (url) => {
    if (String(url).endsWith('/auth/me')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { user: { id: 'u1', email: 'a@a.com', isEmailVerified } } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function Probe() {
  const { user } = useAuth();
  return <span data-testid="verified">{String(!!user?.isEmailVerified)}</span>;
}

const renderBanner = () => render(
  <ToastProvider>
    <AuthProvider>
      <EmailVerificationBanner />
      <Probe />
    </AuthProvider>
  </ToastProvider>,
);

describe('EmailVerificationBanner - preservation (Property 2)', () => {
  beforeEach(() => {
    authApi.resendVerification.mockReset();
  });

  test('Requirement 3.1/3.3 baseline: with no authenticated user (user === null), the banner renders nothing', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/me')) {
        return { ok: false, status: 401, json: async () => ({ code: 'NO_TOKEN' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    renderBanner();

    await waitFor(() => expect(screen.getByTestId('verified').textContent).toBe('false'));
    expect(screen.queryByText('Verify your email address')).not.toBeInTheDocument();
  });

  test('Requirement 3.1: with an unverified user, the banner shows with a "Resend email" action', async () => {
    global.fetch = makeFetchMock(false);
    renderBanner();

    expect(await screen.findByText('Verify your email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend email/i })).toBeInTheDocument();
  });

  test('Requirement 3.2: clicking "Resend email" never changes isEmailVerified and never hides the banner', async () => {
    global.fetch = makeFetchMock(false);
    authApi.resendVerification.mockResolvedValue({ status: 'sent', message: 'Sent!' });

    renderBanner();
    await screen.findByText('Verify your email address');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend email/i }));

    await waitFor(() => expect(authApi.resendVerification).toHaveBeenCalledTimes(1));

    // Banner remains, and AuthContext's user is untouched (still unverified).
    expect(screen.getByText('Verify your email address')).toBeInTheDocument();
    expect(screen.getByTestId('verified').textContent).toBe('false');
  });

  test('a verified user never sees the banner (existing guard, unchanged)', async () => {
    global.fetch = makeFetchMock(true);
    renderBanner();

    await waitFor(() => expect(screen.getByTestId('verified').textContent).toBe('true'));
    expect(screen.queryByText('Verify your email address')).not.toBeInTheDocument();
  });
});
