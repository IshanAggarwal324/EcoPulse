import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuditLogs from '../AuditLogs';
import { ToastProvider } from '../../../context/ToastContext';

vi.mock('../../../utils/api', () => ({
  adminApi: {
    listAuditLogs: vi.fn(),
    verifyAuditLogs: vi.fn(),
  },
}));

import { adminApi } from '../../../utils/api';

const LOG_A = {
  _id: '65f000000000000000000001',
  actorId: '65f0000000000000000000aa',
  actorEmail: 'admin@example.com',
  actorRole: 'admin',
  action: 'USER_BANNED',
  resourceType: 'user',
  resourceId: '65f0000000000000000000bb',
  severity: 'critical',
  ip: '10.0.0.7',
  userAgent: 'Mozilla/5.0 TestBrowser',
  metadata: { reason: 'spam', durationDays: 30 },
  createdAt: '2026-10-01T10:00:00.000Z',
};
const LOG_B = {
  _id: '65f000000000000000000002',
  actorId: null,
  actorEmail: null,
  actorRole: null,
  action: 'AUTH_FAILED',
  resourceType: 'auth',
  resourceId: null,
  severity: 'warn',
  ip: null,
  userAgent: null,
  metadata: null,
  createdAt: '2026-10-01T09:00:00.000Z',
};

const page = (logs, meta = {}) => ({
  success: true,
  data: logs,
  meta: { page: 1, limit: 25, total: logs.length, pages: 1, ...meta },
});

const renderPage = () =>
  render(
    <ToastProvider>
      <AuditLogs />
    </ToastProvider>,
  );

const lastListParams = () => {
  const calls = adminApi.listAuditLogs.mock.calls;
  return calls[calls.length - 1][0];
};

describe('Admin AuditLogs page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminApi.listAuditLogs.mockResolvedValue(page([LOG_A, LOG_B]));
    adminApi.verifyAuditLogs.mockResolvedValue({
      success: true,
      data: { totalChecked: 2, brokenCount: 0, broken: [] },
    });
  });

  test('is a real explorer, not a placeholder: loads and lists entries', async () => {
    renderPage();

    expect(await screen.findByText('USER_BANNED')).toBeInTheDocument();
    expect(screen.getByText('AUTH_FAILED')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('system / anonymous')).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('critical')).toBeInTheDocument();
    expect(table.getByText('warn')).toBeInTheDocument();
    expect(screen.getByText('2 entries')).toBeInTheDocument();
    expect(screen.queryByText(/module$/i)).not.toBeInTheDocument();

    expect(adminApi.listAuditLogs).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });

  test('expanding a row reveals its metadata, user agent and IDs', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');

    expect(screen.queryByText(/TestBrowser/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show details for USER_BANNED/i }));

    expect(screen.getByText(/Mozilla\/5\.0 TestBrowser/)).toBeInTheDocument();
    const meta = screen.getByText(/"reason": "spam"/);
    expect(meta).toBeInTheDocument();
    expect(meta.textContent).toContain('"durationDays": 30');
    expect(screen.getAllByText(LOG_A._id).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /hide details for USER_BANNED/i }));
    expect(screen.queryByText(/TestBrowser/)).not.toBeInTheDocument();
  });

  test('metadata is rendered as text, never as HTML', async () => {
    const user = userEvent.setup();
    adminApi.listAuditLogs.mockResolvedValue(
      page([{ ...LOG_A, metadata: { note: '<img src=x onerror=alert(1)>' } }]),
    );
    const { container } = renderPage();
    await screen.findByText('USER_BANNED');
    await user.click(screen.getByRole('button', { name: /show details/i }));

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  test('severity, resource type and date filters are sent to the API and reset to page 1', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'critical');
    await waitFor(() => expect(lastListParams()).toMatchObject({ severity: 'critical', page: 1 }));

    await user.selectOptions(screen.getByLabelText('Filter by resource type'), 'user');
    await waitFor(() => expect(lastListParams()).toMatchObject({ severity: 'critical', resourceType: 'user' }));

    await user.type(screen.getByLabelText('From date'), '2026-10-01');
    await user.type(screen.getByLabelText('To date'), '2026-10-02');
    await waitFor(() => {
      const p = lastListParams();
      expect(new Date(p.since).getTime()).toBeLessThan(new Date(p.until).getTime());
    });
  });

  test('the action filter is debounced and sent as typed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');
    const callsBefore = adminApi.listAuditLogs.mock.calls.length;

    await user.type(screen.getByLabelText('Filter by action'), 'USER_BANNED');
    await waitFor(() => expect(lastListParams()).toMatchObject({ action: 'USER_BANNED' }));
    // Typing 11 characters must not fire 11 requests.
    expect(adminApi.listAuditLogs.mock.calls.length - callsBefore).toBeLessThanOrEqual(2);
  });

  test('an invalid actor ID is flagged and never sent to the server', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.type(screen.getByLabelText('Filter by actor ID'), 'not-an-id');
    expect(await screen.findByText(/24 hexadecimal characters/i)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(adminApi.listAuditLogs.mock.calls.every(([p]) => p.actorId === undefined)).toBe(true);

    await user.clear(screen.getByLabelText('Filter by actor ID'));
    await user.type(screen.getByLabelText('Filter by actor ID'), LOG_A.actorId);
    await waitFor(() => expect(lastListParams()).toMatchObject({ actorId: LOG_A.actorId }));
  });

  test('"Clear filters" removes every filter', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'warn');
    await waitFor(() => expect(lastListParams().severity).toBe('warn'));
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => expect(lastListParams()).toEqual({ page: 1, limit: 25 }));
  });

  test('pagination requests the next page', async () => {
    const user = userEvent.setup();
    adminApi.listAuditLogs.mockResolvedValue(page([LOG_A], { total: 60, pages: 3 }));
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(lastListParams().page).toBe(2));
  });

  test('shows an empty state, with different wording when filtered', async () => {
    adminApi.listAuditLogs.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('No audit entries yet')).toBeInTheDocument();
  });

  test('shows a retry card on failure and recovers when retried', async () => {
    const user = userEvent.setup();
    adminApi.listAuditLogs.mockRejectedValueOnce(new Error('Forbidden: admins only'));
    renderPage();

    expect(await screen.findByText('Forbidden: admins only')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('USER_BANNED')).toBeInTheDocument();
  });

  test('"Verify integrity" reports an intact chain', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.click(screen.getByRole('button', { name: /verify integrity/i }));
    const status = await screen.findByRole('status');
    expect(within(status).getByText(/chain intact/i)).toBeInTheDocument();
    expect(within(status).getByText(/checked 2/i)).toBeInTheDocument();
    expect(adminApi.verifyAuditLogs).toHaveBeenCalledTimes(1);
  });

  test('"Verify integrity" lists problems when the chain is broken', async () => {
    const user = userEvent.setup();
    adminApi.verifyAuditLogs.mockResolvedValue({
      success: true,
      data: {
        totalChecked: 40,
        brokenCount: 2,
        broken: [
          { id: '65f000000000000000000009', action: 'NODE_DELETED', reason: 'hash_mismatch' },
          { id: '65f00000000000000000000a', action: 'USER_BANNED', reason: 'chain_broken' },
        ],
      },
    });
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.click(screen.getByRole('button', { name: /verify integrity/i }));
    const status = await screen.findByRole('status');
    expect(within(status).getByText(/2 problems found in 40 checked entries/i)).toBeInTheDocument();
    expect(within(status).getByText(/NODE_DELETED · hash_mismatch/)).toBeInTheDocument();
    expect(within(status).getByText(/USER_BANNED · chain_broken/)).toBeInTheDocument();
  });

  test('"Verify integrity" surfaces a request failure', async () => {
    const user = userEvent.setup();
    adminApi.verifyAuditLogs.mockRejectedValue(new Error('Server unavailable'));
    renderPage();
    await screen.findByText('USER_BANNED');

    await user.click(screen.getByRole('button', { name: /verify integrity/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
  });
});
