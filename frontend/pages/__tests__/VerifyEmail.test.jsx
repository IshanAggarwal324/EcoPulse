import React from 'react';
import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VerifyEmail from '../VerifyEmail';
import EmailVerificationBanner from '../../components/EmailVerificationBanner';
import { AuthProvider } from '../../context/AuthContext';
import { ToastProvider } from '../../context/ToastContext';
import { authApi } from '../../utils/api';

// ---------------------------------------------------------------------------
// email-verification-banner-sync bugfix spec — tasks 1 & 2.
//
// Property 1 (Bug Condition): after authApi.verifyEmail(token) resolves
// successfully, AuthContext's user.isEmailVerified should become true (via a
// refetch) and EmailVerificationBanner should stop rendering, without a page
// reload.
//
// Property 2 (Preservation): failed/missing-token verification must NOT
// touch AuthContext at all.
//
// authApi.verifyEmail/resendVerification/etc. are mocked so no real network
// calls happen; AuthContext.jsx's mount-time and refreshUser() refetches are
// driven by a mocked global.fetch that returns the current `verified` flag
// for GET /auth/me. This is a real AuthProvider + real EmailVerificationBanner
// sharing context with VerifyEmail.jsx, matching design.md's Test Case 1/2.
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

const renderApp = (token) => render(
  <MemoryRouter initialEntries={[`/verify-email${token ? `?token=${token}` : ''}`]}>
    <ToastProvider>
      <AuthProvider>
        <EmailVerificationBanner />
        <VerifyEmail />
      </AuthProvider>
    </ToastProvider>
  </MemoryRouter>,
);

describe('VerifyEmail - same-tab AuthContext sync (Property 1: Bug Condition)', () => {
  beforeEach(() => {
    authApi.verifyEmail.mockReset();
    authApi.resendVerification.mockReset();
  });

  test('Test Case 1 (same-tab no-refetch): a successful verifyEmail() call causes AuthContext to refetch /auth/me', async () => {
    let verified = false;
    const fetchMock = makeFetchMock(() => verified);
    global.fetch = fetchMock;

    authApi.verifyEmail.mockImplementation(async () => {
      verified = true; // server-side state change, mirroring the real backend
      return { message: 'Email verified successfully.' };
    });

    renderApp('good-token');

    await screen.findByText('Email verified');

    // AuthContext should have refetched /auth/me a second time (mount fetch +
    // post-verification refresh) so the client picks up isEmailVerified: true.
    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'));
      expect(meCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('Test Case 2 (banner-stays-visible): the banner disappears once verification succeeds, without a reload', async () => {
    let verified = false;
    const fetchMock = makeFetchMock(() => verified);
    global.fetch = fetchMock;

    authApi.verifyEmail.mockImplementation(async () => {
      // Small delay so the test can observe the initial (unverified) banner
      // state before verification resolves, mirroring a real network call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      verified = true;
      return { message: 'Email verified successfully.' };
    });

    renderApp('good-token');

    // Banner shows initially, since the account starts out unverified.
    await waitFor(() => {
      expect(screen.getByText('Verify your email address')).toBeInTheDocument();
    });

    await screen.findByText('Email verified');

    await waitFor(() => {
      expect(screen.queryByText('Verify your email address')).not.toBeInTheDocument();
    });
  });
});

describe('VerifyEmail - preservation (Property 2: error/missing-token paths never touch AuthContext)', () => {
  beforeEach(() => {
    authApi.verifyEmail.mockReset();
    authApi.resendVerification.mockReset();
  });

  test('missing token: never calls authApi.verifyEmail and never refetches /auth/me beyond the initial mount', async () => {
    let verified = false;
    const fetchMock = makeFetchMock(() => verified);
    global.fetch = fetchMock;

    renderApp(null);

    expect(await screen.findByText('Invalid verification link')).toBeInTheDocument();
    expect(authApi.verifyEmail).not.toHaveBeenCalled();

    // Only the AuthProvider's one-time mount fetch of /auth/me should occur.
    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'));
      expect(meCalls.length).toBe(1);
    });
  });

  test('invalid/expired token: verifyEmail rejects, status becomes error, AuthContext is left untouched', async () => {
    let verified = false;
    const fetchMock = makeFetchMock(() => verified);
    global.fetch = fetchMock;

    authApi.verifyEmail.mockRejectedValue(new Error('Invalid or expired token.'));

    renderApp('bad-token');

    expect(await screen.findByText('Verification failed')).toBeInTheDocument();
    expect(screen.getByText('Invalid or expired token.')).toBeInTheDocument();

    // Banner should still show — user was never verified.
    expect(screen.getByText('Verify your email address')).toBeInTheDocument();

    // Only the AuthProvider's one-time mount fetch of /auth/me should occur —
    // no refetch is triggered by the error path.
    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'));
      expect(meCalls.length).toBe(1);
    });
  });
});
