const { test } = require('node:test');
const assert = require('node:assert');

const {
  validateRatingInput,
  sanitizeComment,
  computeReputationFromRatings,
  canRate,
  submitRating,
  MAX_COMMENT_LENGTH,
} = require('../services/reputationService');
const { validateRatingBody } = require('../middleware/ratingGuards');

const WALLET_A = '0x' + 'a'.repeat(40);
const WALLET_B = '0x' + 'b'.repeat(40);
const TX = '0x' + 'c'.repeat(64);

/* ------------------------------------------------------------------ */
/* validateRatingInput — input firewall                                 */
/* ------------------------------------------------------------------ */

test('validateRatingInput accepts and normalizes a valid submission', () => {
  const r = validateRatingInput({
    rater: WALLET_A.toUpperCase(),
    ratedWallet: WALLET_B.toUpperCase(),
    listingId: '7',
    tradeTxHash: TX.toUpperCase(),
    score: '5',
    comment: 'Good',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rater, WALLET_A);
  assert.strictEqual(r.value.ratedWallet, WALLET_B);
  assert.strictEqual(r.value.tradeTxHash, TX);
  assert.strictEqual(r.value.listingId, 7);
  assert.strictEqual(r.value.score, 5);
});

test('validateRatingInput rejects malformed wallets, tx hash, and listing id', () => {
  const base = { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 5 };
  assert.strictEqual(validateRatingInput({ ...base, rater: '0x123' }).ok, false);
  assert.strictEqual(validateRatingInput({ ...base, ratedWallet: 'notahash' }).ok, false);
  assert.strictEqual(validateRatingInput({ ...base, tradeTxHash: '0xshort' }).ok, false);
  assert.strictEqual(validateRatingInput({ ...base, listingId: -1 }).ok, false);
  assert.strictEqual(validateRatingInput({ ...base, listingId: 1.5 }).ok, false);
});

test('validateRatingInput rejects out-of-range / non-integer / boolean scores', () => {
  const base = { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX };
  for (const bad of [0, 6, 3.5, true, false, 'abc', null]) {
    assert.strictEqual(validateRatingInput({ ...base, score: bad }).ok, false, `score ${bad}`);
  }
});

test('validateRatingInput blocks self-rating', () => {
  const r = validateRatingInput({
    rater: WALLET_A,
    ratedWallet: WALLET_A,
    listingId: 7,
    tradeTxHash: TX,
    score: 5,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join(' ').toLowerCase().includes('own'));
});

test('validateRatingInput rejects NoSQL-injection-shaped inputs', () => {
  const base = { rater: WALLET_A, ratedWallet: WALLET_B, tradeTxHash: TX };
  assert.strictEqual(validateRatingInput({ ...base, listingId: 7, score: { $gt: 0 } }).ok, false);
  assert.strictEqual(validateRatingInput({ ...base, listingId: { $gt: 0 }, score: 5 }).ok, false);
});

/* ------------------------------------------------------------------ */
/* sanitizeComment — XSS / smuggling hardening                          */
/* ------------------------------------------------------------------ */

test('sanitizeComment strips HTML tags and stray angle brackets', () => {
  const out = sanitizeComment('Hi <script>alert(1)</script> bye');
  assert.ok(!out.includes('<'), 'no opening bracket');
  assert.ok(!out.includes('>'), 'no closing bracket');
  assert.ok(out.includes('Hi'));
  assert.ok(out.includes('bye'));
});

test('sanitizeComment strips control / null characters', () => {
  assert.strictEqual(sanitizeComment('a\u0000b\u0007c'), 'abc');
  assert.strictEqual(sanitizeComment('x\u000By'), 'xy');
});

test('sanitizeComment collapses whitespace and trims', () => {
  assert.strictEqual(sanitizeComment('  Great   trade  '), 'Great trade');
});

test('sanitizeComment caps length', () => {
  assert.ok(sanitizeComment('x'.repeat(1000)).length <= MAX_COMMENT_LENGTH);
});

test('sanitizeComment handles non-string input safely', () => {
  assert.strictEqual(sanitizeComment(null), '');
  assert.strictEqual(sanitizeComment(undefined), '');
  assert.strictEqual(sanitizeComment(42), '42');
});

/* ------------------------------------------------------------------ */
/* computeReputationFromRatings — pure aggregate                        */
/* ------------------------------------------------------------------ */

test('computeReputationFromRatings aggregates avg, sum, count, distribution', () => {
  const agg = computeReputationFromRatings([{ score: 5 }, { score: 3 }, { score: 4 }]);
  assert.strictEqual(agg.ratingCount, 3);
  assert.strictEqual(agg.ratingSum, 12);
  assert.strictEqual(agg.avgScore, 4);
  assert.strictEqual(agg.scoreDistribution['5'], 1);
  assert.strictEqual(agg.scoreDistribution['3'], 1);
  assert.strictEqual(agg.scoreDistribution['4'], 1);
});

test('computeReputationFromRatings returns zeroes for empty input', () => {
  const agg = computeReputationFromRatings([]);
  assert.strictEqual(agg.avgScore, 0);
  assert.strictEqual(agg.ratingCount, 0);
});

/* ------------------------------------------------------------------ */
/* canRate — verified-trade + idempotency gate                          */
/* ------------------------------------------------------------------ */

const baseValue = { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX };

test('canRate allows when a verified settlement exists and no prior rating', async () => {
  const finders = {
    findVerifiedSettlement: async () => ({ _id: 's1', chainId: 137 }),
    findExistingRating: async () => null,
  };
  const r = await canRate(baseValue, finders);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.settlement.chainId, 137);
});

test('canRate denies with NOT_VERIFIED_TRADE when no settlement', async () => {
  const finders = {
    findVerifiedSettlement: async () => null,
    findExistingRating: async () => null,
  };
  const r = await canRate(baseValue, finders);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, 'NOT_VERIFIED_TRADE');
});

test('canRate denies with ALREADY_RATED when a prior rating exists', async () => {
  const finders = {
    findVerifiedSettlement: async () => ({ chainId: 1 }),
    findExistingRating: async () => ({ _id: 'r1' }),
  };
  const r = await canRate(baseValue, finders);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, 'ALREADY_RATED');
});

test('canRate forwards the exact (normalized) trade tuple to the settlement finder', async () => {
  let captured = null;
  const finders = {
    findVerifiedSettlement: async (q) => {
      captured = q;
      return null;
    },
    findExistingRating: async () => null,
  };
  await canRate(baseValue, finders);
  assert.strictEqual(captured.rater, WALLET_A);
  assert.strictEqual(captured.ratedWallet, WALLET_B);
  assert.strictEqual(captured.listingId, 7);
  assert.strictEqual(captured.tradeTxHash, TX);
});

/* ------------------------------------------------------------------ */
/* submitRating — end-to-end write path with injected deps              */
/* ------------------------------------------------------------------ */

test('submitRating creates a normalized, sanitized rating and recomputes reputation', async () => {
  let settlementQuery = null;
  let created = null;
  let recomputeArg = null;
  const finders = {
    findVerifiedSettlement: async (q) => {
      settlementQuery = q;
      return { chainId: 137 };
    },
    findExistingRating: async () => null,
  };
  const createRating = async (doc) => {
    created = doc;
    return { ...doc, _id: 'r1' };
  };
  const recompute = async (wallet) => {
    recomputeArg = wallet;
    return {};
  };

  const out = await submitRating(
    {
      rater: WALLET_A.toUpperCase(),
      ratedWallet: WALLET_B.toUpperCase(),
      listingId: '7',
      tradeTxHash: TX.toUpperCase(),
      score: '5',
      comment: 'Good <b>seller</b>',
    },
    { finders, createRating, recompute, nodeId: null },
  );

  assert.strictEqual(created.raterWallet, WALLET_A);
  assert.strictEqual(created.ratedWallet, WALLET_B);
  assert.strictEqual(created.tradeTxHash, TX);
  assert.strictEqual(created.listingId, 7);
  assert.strictEqual(created.score, 5);
  assert.strictEqual(created.chainId, 137);
  assert.ok(!created.comment.includes('<'), 'stored comment must be sanitized');
  assert.strictEqual(settlementQuery.rater, WALLET_A);
  assert.strictEqual(settlementQuery.ratedWallet, WALLET_B);
  assert.strictEqual(recomputeArg, WALLET_B);
  assert.strictEqual(out._id, 'r1');
});

test('submitRating throws 400 INVALID_INPUT on a bad score', async () => {
  await assert.rejects(
    submitRating(
      { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 9 },
      { nodeId: null },
    ),
    (err) => err.status === 400 && err.code === 'INVALID_INPUT',
  );
});

test('submitRating throws 403 NOT_VERIFIED_TRADE when trade is not verified', async () => {
  const finders = {
    findVerifiedSettlement: async () => null,
    findExistingRating: async () => null,
  };
  await assert.rejects(
    submitRating(
      { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 4 },
      { finders, nodeId: null },
    ),
    (err) => err.status === 403 && err.code === 'NOT_VERIFIED_TRADE',
  );
});

test('submitRating throws 409 ALREADY_RATED when gate detects a prior rating', async () => {
  const finders = {
    findVerifiedSettlement: async () => ({ chainId: 1 }),
    findExistingRating: async () => ({ _id: 'x' }),
  };
  await assert.rejects(
    submitRating(
      { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 4 },
      { finders, nodeId: null },
    ),
    (err) => err.status === 409 && err.code === 'ALREADY_RATED',
  );
});

test('submitRating treats a duplicate-key race as 409 ALREADY_RATED', async () => {
  const finders = {
    findVerifiedSettlement: async () => ({ chainId: 1 }),
    findExistingRating: async () => null,
  };
  const createRating = async () => {
    const e = new Error('duplicate key');
    e.code = 11000;
    throw e;
  };
  await assert.rejects(
    submitRating(
      { rater: WALLET_A, ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 4 },
      { finders, createRating, nodeId: null },
    ),
    (err) => err.status === 409 && err.code === 'ALREADY_RATED',
  );
});

/* ------------------------------------------------------------------ */
/* ratingGuards — rater identity is taken from the session, not body    */
/* ------------------------------------------------------------------ */

test('guard derives rater from the session and ignores a spoofed body.rater', () => {
  const req = {
    user: { walletAddress: WALLET_A },
    body: {
      rater: WALLET_B,
      ratedWallet: WALLET_B,
      listingId: 7,
      tradeTxHash: TX,
      score: 5,
    },
  };
  let nextCalled = false;
  validateRatingBody(req, {}, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled, 'valid submission should pass the guard');
  assert.strictEqual(req.rating.rater, WALLET_A, 'spoofed body.rater must be ignored');
});

test('guard returns 400 on an invalid score', () => {
  let captured = null;
  const req = {
    user: { walletAddress: WALLET_A },
    body: { ratedWallet: WALLET_B, listingId: 7, tradeTxHash: TX, score: 9 },
  };
  const res = {
    status: (code) => ({ json: (payload) => {
      captured = { code, payload };
    } }),
  };
  validateRatingBody(req, res, () => {});
  assert.strictEqual(captured.code, 400);
  assert.strictEqual(captured.payload.success, false);
});
