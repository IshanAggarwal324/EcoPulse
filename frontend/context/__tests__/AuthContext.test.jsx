import React from 'react';
import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { authApi } from '../../utils/api';

// ---------------------------------------------------------------------------
// email-verification-banner-sync bugfix spec — tasks 1 & 2.
//
// Property 1 (Bug Condition), Test Case 3: two independent AuthProvider
// instances ("tab A" / "tab B") sharing localStorage + a mocked backend; tab
// A completes verification; tab B should learn about it via the storage
// cross-tab signal and refetch /auth/me.
//
// Property 2 (Preservation): random AuthContext action sequences and random
// `storage` events must not be affected by the fix, and (pre-fix) no
// `storage` listener exists at all.
//
// jsdom does not natively dispatch `storage` events for same-window
// localStorage writes (real browsers only deliver them to *other* windows,
// and a single jsdom window can't emulate "other window" automatically), so
// tests that need a cross-tab signal manually dispatch a StorageEvent on
// `window` mirroring what the browser would deliver to another tab. This
// still faithfully exercises the code path: pre-fix there is no listener to
// receive it, post-fix AuthProvider's real listener handles it.
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

const EMAIL_VERIFIED_SYNC_KEY = 'ecopulse.auth.emailVerifiedAt';

function Probe({ testId }) {
  const { user, loading } = useAuth();
  return (
    <span data-testid={testId}>
      {loading ? 'loading' : String(!!user?.isEmailVerified)}
    </span>
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

describe('AuthContext - cross-tab sync (Property 1: Bug Condition, Test Case 3)', () => {
  beforeEach(() => {
    authApi.verifyEmail.mockReset();
    window.localStorage.clear();
  });

  test('tab B refetches and becomes verified after tab A completes verification and the storage signal is delivered', async () => {
    let verified = false;
    const fetchMock = makeFetchMock(() => verified);
    global.fetch = fetchMock;

    authApi.verifyEmail.mockImplementation(async () => {
      verified = true;
      return { message: 'Email verified successfully.' };
    });

    // Tab A: an independent AuthProvider instance that will perform the
    // verification. (VerifyEmail.jsx's router-dependent success path is
    // covered end-to-end in pages/__tests__/VerifyEmail.test.jsx and
    // __tests__/emailVerificationSync.integration.test.jsx; this file keeps
    // its focus on AuthContext's own cross-tab contract.)
    let tabACtx;
    function TabACapture() {
      tabACtx = useAuth();
      return null;
    }
    render(<AuthProvider><TabACapture /></AuthProvider>);

    // Tab B: independent AuthProvider instance, sharing the same window
    // (and therefore the same localStorage) and the same mocked fetch.
    render(
      <AuthProvider>
        <Probe testId="tab-b-verified" />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('tab-b-verified').textContent).toBe('false');
    });

    // Simulate tab A's real action: call verifyEmail directly against the
    // mocked API (mirrors what VerifyEmail.jsx's success handler does), then
    // refresh tab A's own user and attempt to broadcast to other tabs. On
    // unfixed code, `broadcastEmailVerified` does not exist on the context
    // value at all, so this is a no-op and nothing is written to
    // localStorage (confirming the bug: tab B never learns). On fixed code,
    // it writes the EMAIL_VERIFIED_SYNC_KEY timestamp.
    await act(async () => {
      await authApi.verifyEmail('good-token');
      await tabACtx.refreshUser();
      await tabACtx.broadcastEmailVerified?.();
    });

    // Real browsers only deliver `storage` events to *other* windows; jsdom
    // does not deliver them at all automatically (even same-window), so we
    // manually dispatch what the browser would deliver to tab B, using
    // whatever is actually in localStorage after tab A's broadcast (falsy /
    // absent pre-fix, a real timestamp post-fix).
    act(() => {
      window.dispatchEvent(new window.StorageEvent('storage', {
        key: EMAIL_VERIFIED_SYNC_KEY,
        newValue: window.localStorage.getItem(EMAIL_VERIFIED_SYNC_KEY),
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tab-b-verified').textContent).toBe('true');
    });
  });
});

describe('AuthContext - preservation: random action sequences (Property 2)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // Deterministic PRNG so failures are reproducible.
  function makeRng(seed) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  test('any sequence of login/register/updateProfile/refreshUser/refreshSession/logout leaves user matching the last successful mutation\'s server response', async () => {
    const actions = ['login', 'register', 'updateProfile', 'refreshUser', 'refreshSession', 'logout'];

    for (let trial = 0; trial < 25; trial++) {
      const rng = makeRng(trial + 1);
      const sequenceLength = 3 + Math.floor(rng() * 5);
      const sequence = Array.from(
        { length: sequenceLength },
        () => actions[Math.floor(rng() * actions.length)],
      );

      let serverUser = null;

      global.fetch = vi.fn(async (url, options = {}) => {
        const method = (options.method || 'GET').toUpperCase();
        if (String(url).endsWith('/auth/me')) {
          return {
            ok: !!serverUser,
            status: serverUser ? 200 : 401,
            json: async () => (serverUser
              ? { data: { user: serverUser } }
              : { code: 'NO_TOKEN' }),
          };
        }
        if (String(url).endsWith('/auth/login') && method === 'POST') {
          serverUser = { id: 'u1', email: 'a@a.com', isEmailVerified: false };
          return { ok: true, status: 200, json: async () => ({ data: { user: serverUser } }) };
        }
        if (String(url).endsWith('/auth/register') && method === 'POST') {
          serverUser = { id: 'u2', email: 'b@b.com', isEmailVerified: false };
          return { ok: true, status: 200, json: async () => ({ data: { user: serverUser } }) };
        }
        if (String(url).endsWith('/auth/refresh') && method === 'POST') {
          return { ok: !!serverUser, status: serverUser ? 200 : 401, json: async () => ({ data: { user: serverUser } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      authApi.updateProfile.mockImplementation(async () => {
        serverUser = { ...(serverUser || { id: 'u1', email: 'a@a.com' }), isEmailVerified: false, updated: true };
        return { data: { user: serverUser }, message: 'ok' };
      });
      authApi.logout.mockResolvedValue({});

      let ctx;
      function Capture() {
        ctx = useAuth();
        return null;
      }
      render(<AuthProvider><Capture /></AuthProvider>);

      await waitFor(() => expect(ctx.loading).toBe(false));

      for (const action of sequence) {
        await act(async () => {
          if (action === 'login') await ctx.login('a@a.com', 'pw');
          else if (action === 'register') await ctx.register({ email: 'b@b.com', password: 'pw' });
          else if (action === 'updateProfile') await ctx.updateProfile({ name: 'x' });
          else if (action === 'refreshUser') await ctx.refreshUser();
          else if (action === 'refreshSession') await ctx.refreshSession();
          else if (action === 'logout') await ctx.logout();
        });
      }

      // Invariant that must hold regardless of the verification-sync fix
      // (none of these functions are touched by it): user is either null
      // (post-logout / never authenticated) or exactly the last known server
      // user object's id/email — the fix must never alter this.
      if (sequence[sequence.length - 1] === 'logout') {
        expect(ctx.user).toBeNull();
      } else if (serverUser) {
        expect(ctx.user?.id).toBe(serverUser.id);
        expect(ctx.user?.email).toBe(serverUser.email);
      }
    }
  });

  test('random UNRELATED storage events (non-bug-condition inputs): fetchCurrentUser is never re-triggered, pre- or post-fix', async () => {
    // This is the Property 2 (Preservation) case: any storage activity that
    // is NOT (key === EMAIL_VERIFIED_SYNC_KEY AND newValue truthy) is outside
    // the bug condition entirely, so it must have zero effect both before and
    // after the fix. (The sync-key + truthy-value combination is Property 1
    // territory — covered by the cross-tab test above, not here.)
    const rng = makeRng(7);
    const unrelatedKeys = ['unrelated.key', 'ecopulse.other', EMAIL_VERIFIED_SYNC_KEY];

    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ data: { user: { id: 'u1', isEmailVerified: false } } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    global.fetch = fetchMock;

    render(<AuthProvider><Probe testId="p" /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('p').textContent).toBe('false'));

    const callsAfterMount = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/me')).length;

    for (let i = 0; i < 20; i++) {
      const key = unrelatedKeys[Math.floor(rng() * unrelatedKeys.length)];
      // If we happened to pick EMAIL_VERIFIED_SYNC_KEY, only use a falsy
      // newValue (cleared) so this event stays outside the bug condition.
      const newValue = key === EMAIL_VERIFIED_SYNC_KEY
        ? (rng() > 0.5 ? '' : null)
        : (rng() > 0.5 ? String(rng()) : null);
      window.dispatchEvent(new window.StorageEvent('storage', { key, newValue }));
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    const callsAfterEvents = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/me')).length;
    expect(callsAfterEvents).toBe(callsAfterMount);
  });
});
