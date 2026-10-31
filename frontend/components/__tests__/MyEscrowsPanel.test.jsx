import React from 'react';
import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyEscrowsPanel, { roleOf, describeNextStep } from '../trading/MyEscrowsPanel';
import MarketplaceOrderCard from '../ui/MarketplaceOrderCard';
import { escrowApi } from '../../utils/api';
import {
  confirmDelivery, releaseEscrow, openDispute, claimTimeoutRefund, getEscrowDisputeWindow,
} from '../../utils/blockchain';

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';

let currentAccount = BUYER;
const toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };

vi.mock('../../context/WalletContext', () => ({ useWallet: () => ({ account: currentAccount }) }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => toast }));
vi.mock('../../context/SocketContext', () => ({ useSocketEvent: vi.fn() }));
vi.mock('../../utils/api', () => ({ escrowApi: { list: vi.fn(), indexTx: vi.fn() } }));
vi.mock('../../utils/blockchain', () => ({
  confirmDelivery: vi.fn(),
  releaseEscrow: vi.fn(),
  openDispute: vi.fn(),
  claimTimeoutRefund: vi.fn(),
  getEscrowDisputeWindow: vi.fn(),
}));
vi.mock('../ui/ReputationBadge', () => ({ default: () => null }));

const HOUR = 3600 * 1000;
const escrow = (overrides = {}) => ({
  escrowId: 3,
  listingId: 7,
  buyer: BUYER,
  seller: SELLER,
  amountEther: '12.0',
  state: 'funded',
  createdAt: new Date(Date.now() - HOUR).toISOString(),
  contractAddress: '0xescrow',
  ...overrides,
});

const setup = async (rows, props = {}) => {
  escrowApi.list.mockResolvedValue({ data: rows });
  render(<MyEscrowsPanel {...props} />);
  await waitFor(() => expect(escrowApi.list).toHaveBeenCalled());
};

beforeEach(() => {
  vi.clearAllMocks();
  currentAccount = BUYER;
  getEscrowDisputeWindow.mockResolvedValue(72 * 3600);
  escrowApi.indexTx.mockResolvedValue({ data: [] });
});

describe('roleOf / describeNextStep', () => {
  test('derives the role by comparing wallets case-insensitively', () => {
    expect(roleOf(escrow(), BUYER.toUpperCase().replace('0X', '0x'))).toBe('buyer');
    expect(roleOf(escrow(), SELLER)).toBe('seller');
    expect(roleOf(escrow(), '0x3333333333333333333333333333333333333333')).toBeNull();
    expect(roleOf(escrow(), null)).toBeNull();
  });

  test('explains the next step for each role and state', () => {
    expect(describeNextStep(escrow(), 'seller', null)).toMatch(/Confirm delivery/);
    expect(describeNextStep(escrow(), 'buyer', null)).toMatch(/Release them/);
    expect(describeNextStep(escrow({ state: 'disputed' }), 'buyer', null)).toMatch(/arbiter/);
    expect(describeNextStep(escrow({ state: 'refunded' }), 'buyer', null)).toMatch(/returned to the buyer/);
    expect(describeNextStep(escrow({ state: 'released' }), 'seller', null)).toMatch(/paid to the seller/);
  });
});

describe('MyEscrowsPanel', () => {
  test('buyer with a funded escrow can release or open a dispute, but cannot confirm delivery or refund yet', async () => {
    await setup([escrow()]);
    expect(await screen.findByText('Escrow #3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /release funds to seller/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open dispute/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm delivery/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim refund/i })).not.toBeInTheDocument();
  });

  test('seller sees only Confirm delivery on a funded escrow', async () => {
    currentAccount = SELLER;
    await setup([escrow()]);
    expect(await screen.findByRole('button', { name: /confirm delivery/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release funds/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open dispute/i })).not.toBeInTheDocument();
  });

  test('after the dispute window the buyer gets Claim refund instead of Open dispute', async () => {
    await setup([escrow({ createdAt: new Date(Date.now() - 80 * HOUR).toISOString() })]);
    expect(await screen.findByRole('button', { name: /claim refund/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open dispute/i })).not.toBeInTheDocument();
  });

  test('finished and disputed escrows offer no actions', async () => {
    await setup([
      escrow({ escrowId: 1, state: 'refunded' }),
      escrow({ escrowId: 2, state: 'released' }),
      escrow({ escrowId: 3, state: 'disputed' }),
    ]);
    expect(await screen.findByText('Escrow #1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release funds|open dispute|claim refund|confirm delivery/i })).not.toBeInTheDocument();
  });

  test('does not list escrows the connected wallet is not a party to', async () => {
    currentAccount = '0x3333333333333333333333333333333333333333';
    await setup([escrow()]);
    expect(await screen.findByText(/No escrows yet/i)).toBeInTheDocument();
  });

  test('releasing sends the transaction, then indexes it and refreshes', async () => {
    releaseEscrow.mockResolvedValue({ hash: '0xabc' });
    const onChanged = vi.fn();
    await setup([escrow()], { onChanged });
    await userEvent.click(await screen.findByRole('button', { name: /release funds to seller/i }));
    await waitFor(() => expect(releaseEscrow).toHaveBeenCalledWith(3));
    await waitFor(() => expect(escrowApi.indexTx).toHaveBeenCalledWith('0xabc'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(escrowApi.list.mock.calls.length).toBeGreaterThan(1);
  });

  test('seller confirms delivery through the chain helper', async () => {
    currentAccount = SELLER;
    confirmDelivery.mockResolvedValue({ hash: '0xdef' });
    await setup([escrow()]);
    await userEvent.click(await screen.findByRole('button', { name: /confirm delivery/i }));
    await waitFor(() => expect(confirmDelivery).toHaveBeenCalledWith(3));
  });

  test('claiming a refund calls the timeout refund helper', async () => {
    claimTimeoutRefund.mockResolvedValue({ hash: '0x123' });
    await setup([escrow({ createdAt: new Date(Date.now() - 80 * HOUR).toISOString() })]);
    await userEvent.click(await screen.findByRole('button', { name: /claim refund/i }));
    await waitFor(() => expect(claimTimeoutRefund).toHaveBeenCalledWith(3));
  });

  test('a dispute needs a written reason, then is submitted on-chain with it', async () => {
    openDispute.mockResolvedValue({ hash: '0x456' });
    await setup([escrow()]);
    await userEvent.click(await screen.findByRole('button', { name: /^open dispute$/i }));

    await userEvent.click(screen.getByRole('button', { name: /submit dispute/i }));
    expect(openDispute).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/Describe the problem/));

    await userEvent.type(screen.getByLabelText(/what went wrong/i), 'Never delivered');
    await userEvent.click(screen.getByRole('button', { name: /submit dispute/i }));
    await waitFor(() => expect(openDispute).toHaveBeenCalledWith(3, 'Never delivered'));
  });

  test('a rejected wallet prompt shows a friendly message and leaves the list alone', async () => {
    releaseEscrow.mockRejectedValue(Object.assign(new Error('x'), { code: 'ACTION_REJECTED' }));
    await setup([escrow()]);
    await userEvent.click(await screen.findByRole('button', { name: /release funds to seller/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Transaction cancelled in your wallet.'));
    expect(escrowApi.indexTx).not.toHaveBeenCalled();
  });

  test('seller can close the listing after being paid, only while it is still active', async () => {
    currentAccount = SELLER;
    const onCloseListing = vi.fn();
    await setup([escrow({ state: 'released' })], { activeListingIds: [7], onCloseListing });
    await userEvent.click(await screen.findByRole('button', { name: /close listing #7/i }));
    expect(onCloseListing).toHaveBeenCalledWith(7);
  });

  test('no close-listing button once the listing is no longer active', async () => {
    currentAccount = SELLER;
    await setup([escrow({ state: 'released' })], { activeListingIds: [], onCloseListing: vi.fn() });
    await screen.findByText('Escrow #3');
    expect(screen.queryByRole('button', { name: /close listing/i })).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderCard with an open escrow', () => {
  const order = {
    listingId: 7, seller: SELLER, energyAmount: 10, price: 12, unitPrice: 1.2, inEscrow: true,
  };

  test('shows "In escrow" and hides the buy buttons from other users', () => {
    render(
      <MarketplaceOrderCard
        order={order}
        account={BUYER}
        loading={false}
        isCorrectNetwork
        onPurchase={vi.fn()}
        onPurchaseEscrow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('In escrow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy via escrow/i })).not.toBeInTheDocument();
  });

  test('a normal order still shows both buy buttons', () => {
    render(
      <MarketplaceOrderCard
        order={{ ...order, inEscrow: false }}
        account={BUYER}
        loading={false}
        isCorrectNetwork
        onPurchase={vi.fn()}
        onPurchaseEscrow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /buy now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /buy via escrow/i })).toBeInTheDocument();
  });

  test('the seller can still cancel their own order that is in escrow', () => {
    render(
      <MarketplaceOrderCard
        order={order}
        account={SELLER}
        loading={false}
        isCorrectNetwork
        onPurchase={vi.fn()}
        onPurchaseEscrow={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /cancel order/i })).toBeInTheDocument();
  });
});
