const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compactUpdate } = require('../utils/compactUpdate');
const Escrow = require('../models/Escrow');
const Dispute = require('../models/Dispute');
const escrowService = require('../services/escrowService');
const disputeService = require('../services/disputeService');
const BlockchainService = require('../services/blockchainService');
const { applyEscrowFlags } = require('../services/marketplaceService');

const CHAIN = 11155111;
const ESCROW_ADDR = '0xA0993932AF92cB0BD0930964D45bfc620fE2AF5A';

/** Runs fn with Model.findOneAndUpdate captured, restoring it afterwards. */
const captureUpdate = async (Model, fn) => {
  const original = Model.findOneAndUpdate;
  const calls = [];
  Model.findOneAndUpdate = async (filter, update) => {
    calls.push({ filter, update });
    return { ...update.$set };
  };
  try {
    await fn();
  } finally {
    Model.findOneAndUpdate = original;
  }
  return calls;
};

test('compactUpdate drops null/undefined but keeps false and 0', () => {
  assert.deepEqual(
    compactUpdate({ a: 1, b: null, c: undefined, d: false, e: 0, f: '' }),
    { a: 1, d: false, e: 0, f: '' },
  );
});

test('a state-only escrow event does NOT overwrite buyer, seller, amount or listing with null', async () => {
  const calls = await captureUpdate(Escrow, () =>
    escrowService.upsertEscrowFromEvent({
      escrowId: 1,
      state: 'released',
      txHash: '0xABC',
      blockNumber: 99,
      chainId: CHAIN,
      contractAddress: ESCROW_ADDR,
    }));
  assert.equal(calls.length, 1);
  const set = calls[0].update.$set;
  assert.equal(set.state, 'released');
  for (const key of ['buyer', 'seller', 'amount', 'amountEther', 'listingId', 'createdAt', 'deliveredAt', 'disputeId']) {
    assert.ok(!(key in set), `${key} must not be written by a state-only event`);
  }
  assert.equal(set.txHash, '0xabc');
});

test('EscrowCreated writes the full record, including listing id', async () => {
  const calls = await captureUpdate(Escrow, () =>
    escrowService.upsertEscrowFromEvent({
      escrowId: 0,
      listingId: 5,
      buyer: '0xBUYER',
      seller: '0xSELLER',
      amount: '12000000000000000000',
      amountEther: '12.0',
      state: 'funded',
      chainId: CHAIN,
      contractAddress: ESCROW_ADDR,
    }));
  const set = calls[0].update.$set;
  assert.equal(set.listingId, 5);
  assert.equal(set.buyer, '0xbuyer');
  assert.equal(set.seller, '0xseller');
  assert.equal(set.amountEther, '12.0');
  assert.equal(set.state, 'funded');
});

test('a dispute-opened event does not null the parties, and never un-resolves a dispute', async () => {
  const calls = await captureUpdate(Dispute, async () => {
    await disputeService.upsertDisputeFromEvent({
      disputeId: 0,
      escrowId: 0,
      buyer: null,
      seller: null,
      amount: '0',
      resolved: false,
      chainId: CHAIN,
      contractAddress: '0xdispute',
    });
  });
  const set = calls[0].update.$set;
  assert.ok(!('buyer' in set) && !('seller' in set));
  assert.ok(!('resolved' in set), 'an opened event must not reset resolved to false');

  const resolvedCalls = await captureUpdate(Dispute, () =>
    disputeService.upsertDisputeFromEvent({
      disputeId: 0,
      escrowId: 0,
      resolved: true,
      outcome: 'refund',
      chainId: CHAIN,
      contractAddress: '0xdispute',
    }));
  assert.equal(resolvedCalls[0].update.$set.resolved, true);
  assert.equal(resolvedCalls[0].update.$set.outcome, 'refund');
});

test('applyEscrowFlags marks only listings with an open escrow', () => {
  const orders = [
    { listingId: 3, seller: '0xSeller3', price: 12 },
    { listingId: '4', seller: '0xseller4', price: 5 },
    { listingId: 9, seller: '0xseller9', price: 1 },
  ];
  const flagged = applyEscrowFlags(orders, [
    { listingId: 3, state: 'funded', seller: '0xseller3', amountEther: '12.0' },
    { listingId: 4, state: 'disputed', seller: '0xSELLER4', amountEther: '7' },
    { listingId: null, state: 'funded', seller: '0xseller9', amountEther: '1' },
  ]);
  assert.deepEqual(
    flagged.map((o) => [o.listingId, o.inEscrow, o.escrowState]),
    [[3, true, 'funded'], ['4', true, 'disputed'], [9, false, null]],
  );
  assert.deepEqual(applyEscrowFlags([{ listingId: 1 }], undefined)[0].inEscrow, false);
});

test('a stray escrow cannot hide someone else\'s order: wrong seller or too little locked does not count', () => {
  const orders = [{ listingId: 5, seller: '0xRealSeller', price: 10 }];
  const wrongSeller = applyEscrowFlags(orders, [
    { listingId: 5, state: 'funded', seller: '0xsomeoneelse', amountEther: '10' },
  ]);
  assert.equal(wrongSeller[0].inEscrow, false);

  const tooLittle = applyEscrowFlags(orders, [
    { listingId: 5, state: 'funded', seller: '0xrealseller', amountEther: '0.000001' },
  ]);
  assert.equal(tooLittle[0].inEscrow, false);

  const genuine = applyEscrowFlags(orders, [
    { listingId: 5, state: 'funded', seller: '0xrealseller', amountEther: '10.0' },
  ]);
  assert.equal(genuine[0].inEscrow, true);
});

/* ---- indexEscrowTx: reads the confirmed receipt, ignores foreign logs ---- */

const withFakeChain = async ({ receipt, parsedByTopic }, fn) => {
  const saved = {
    getRO: BlockchainService.getEnergyEscrowContractReadOnly,
    getAddr: BlockchainService.getEscrowAddresses,
    escrowFind: Escrow.findOne,
    escrowUpdate: Escrow.findOneAndUpdate,
  };
  const provider = {
    getTransactionReceipt: async () => receipt,
    getNetwork: async () => ({ chainId: BigInt(CHAIN) }),
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
  };
  BlockchainService.getEnergyEscrowContractReadOnly = () => ({
    runner: { provider },
    interface: { parseLog: ({ topics }) => parsedByTopic[topics[0]] || null },
    getEscrow: async () => [
      '0xBuyer000000000000000000000000000000001', '0xSeller00000000000000000000000000000002', 12n * 10n ** 18n, 0n, 1_700_000_000n, 0n,
    ],
  });
  BlockchainService.getEscrowAddresses = () => ({ energyEscrowAddress: ESCROW_ADDR, disputeResolutionAddress: '0xdispute' });
  const stored = new Map();
  Escrow.findOneAndUpdate = async (filter, update) => {
    stored.set(filter.escrowId, { ...(stored.get(filter.escrowId) || {}), ...update.$set });
    return stored.get(filter.escrowId);
  };
  Escrow.findOne = (filter) => ({ lean: async () => stored.get(filter.escrowId) || null });
  try {
    return await fn(stored);
  } finally {
    BlockchainService.getEnergyEscrowContractReadOnly = saved.getRO;
    BlockchainService.getEscrowAddresses = saved.getAddr;
    Escrow.findOne = saved.escrowFind;
    Escrow.findOneAndUpdate = saved.escrowUpdate;
  }
};

test('indexEscrowTx indexes EscrowCreated from the receipt and ignores logs from other contracts', async () => {
  const receipt = {
    status: 1,
    logs: [
      { address: '0x6393380E22Ab40dA9265299667969176ad3D47A7', topics: ['0xtransfer'], data: '0x', blockNumber: 10, transactionHash: '0xaa' },
      { address: ESCROW_ADDR, topics: ['0xcreated'], data: '0x', blockNumber: 10, transactionHash: '0xaa' },
    ],
  };
  const parsedByTopic = {
    '0xcreated': {
      name: 'EscrowCreated',
      args: {
        escrowId: 4n, listingId: 7n, buyer: '0xBuyer000000000000000000000000000000001', seller: '0xSeller00000000000000000000000000000002', amount: 12n * 10n ** 18n,
      },
    },
    '0xtransfer': { name: 'Transfer', args: {} },
  };
  await withFakeChain({ receipt, parsedByTopic }, async (stored) => {
    const records = await escrowService.indexEscrowTx(`0x${'a'.repeat(64)}`);
    assert.equal(records.length, 1);
    assert.equal(records[0].listingId, 7, 'listing id comes from the EscrowCreated event');
    assert.equal(records[0].state, 'funded');
    assert.equal(records[0].amountEther, '12.0');
    assert.equal(stored.size, 1);
  });
});

test('indexEscrowTx rejects a missing or reverted transaction', async () => {
  await withFakeChain({ receipt: null, parsedByTopic: {} }, async () => {
    await assert.rejects(() => escrowService.indexEscrowTx(`0x${'b'.repeat(64)}`), (err) => err.statusCode === 404);
  });
  await withFakeChain({ receipt: { status: 0, logs: [] }, parsedByTopic: {} }, async () => {
    await assert.rejects(() => escrowService.indexEscrowTx(`0x${'c'.repeat(64)}`), (err) => err.statusCode === 422);
  });
});

test('refreshOpenEscrows keeps terminal rows untouched and falls back to stored rows on failure', async () => {
  const rows = [
    { escrowId: 0, state: 'refunded' },
    { escrowId: 1, state: 'funded', chainId: CHAIN, contractAddress: ESCROW_ADDR },
  ];
  // No chain configured in tests: the refresh of the open row fails and is swallowed.
  const out = await escrowService.refreshOpenEscrows(rows);
  assert.deepEqual(out.map((r) => [r.escrowId, r.state]), [[0, 'refunded'], [1, 'funded']]);
});
