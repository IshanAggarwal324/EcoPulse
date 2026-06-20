const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 3.2 — pure-logic invariants for the live-context layer.
// (DB-backed retrievers are integration-tested elsewhere; these cover the
// pieces that must be correct without a database: intent routing, node-id
// detection, and bill-analysis math.)

const {
  classifyIntent,
  detectNodeIdFromMessage,
  matchBillAnalysisIntent,
  matchNodeDetailIntent,
} = require('../services/intentClassifier');
const { computeBillAnalysis } = require('../services/assistantRetrievers');

/* ------------------------------------------------------------------ */
/* Intent classification (3.2.7)                                        */
/* ------------------------------------------------------------------ */

test('classifyIntent routes bill/usage queries to bill_analysis', () => {
  assert.strictEqual(classifyIntent('How much energy did I use this week?').intent, 'bill_analysis');
  assert.strictEqual(classifyIntent('compare my usage to last month').intent, 'bill_analysis');
  assert.strictEqual(classifyIntent('any spike in my consumption?').intent, 'bill_analysis');
});

test('classifyIntent routes node-detail queries to node_detail', () => {
  assert.strictEqual(classifyIntent('give me details for my solar node').intent, 'node_detail');
  assert.strictEqual(classifyIntent('status of Home Solar please').intent, 'node_detail');
  // A bare 24-hex id alongside a node word is enough for node_detail.
  const id = '507f1f77bcf86cd799439011';
  assert.strictEqual(classifyIntent(`show me node ${id}`).intent, 'node_detail');
});

test('classifyIntent keeps existing intents intact', () => {
  assert.strictEqual(classifyIntent('what is my profit?').intent, 'wallet_profit');
  assert.strictEqual(classifyIntent('show me the forecast').intent, 'forecast');
  assert.strictEqual(classifyIntent('how many trades today?').intent, 'trades');
  assert.strictEqual(classifyIntent('what are carbon credits?').intent, 'carbon');
});

test('classifyIntent always returns a nodeId field (null when absent)', () => {
  assert.strictEqual(classifyIntent('hello there').nodeId, null);
  const id = '507f1f77bcf86cd799439011';
  assert.strictEqual(classifyIntent(`info about node ${id}`).nodeId, id);
});

test('detectNodeIdFromMessage extracts the first 24-hex id', () => {
  assert.strictEqual(detectNodeIdFromMessage('node 507f1f77bcf86cd799439011 status'), '507f1f77bcf86cd799439011');
  assert.strictEqual(detectNodeIdFromMessage('no id here'), null);
  assert.strictEqual(detectNodeIdFromMessage(null), null);
});

test('matchBillAnalysisIntent / matchNodeDetailIntent are non-string safe', () => {
  assert.strictEqual(matchBillAnalysisIntent(undefined), false);
  assert.strictEqual(matchNodeDetailIntent(null), false);
});

/* ------------------------------------------------------------------ */
/* Bill analysis math (3.2.4)                                           */
/* ------------------------------------------------------------------ */

const node = (name, consumed, generated = 0) => ({ name, totalConsumed: consumed, totalGenerated: generated });

test('computeBillAnalysis computes period-over-period delta and top nodes', () => {
  const r = computeBillAnalysis(
    { totalConsumed: 142 },
    { totalConsumed: 98 },
    [node('Home Solar', 80), node('Wind', 40), node('Flat', 22)],
    [node('Home Solar', 40)],
  );
  assert.strictEqual(r.totalConsumedKwh, 142);
  assert.strictEqual(r.priorPeriodConsumedKwh, 98);
  assert.strictEqual(r.deltaPercent, 45); // (142-98)/98
  assert.strictEqual(r.topNodes[0].name, 'Home Solar');
  assert.strictEqual(r.topNodes[0].consumedKwh, 80);
  assert.strictEqual(r.topNodes.length, 3);
});

test('computeBillAnalysis flags a node whose usage spiked >= 1.5x', () => {
  const r = computeBillAnalysis(
    { totalConsumed: 120 },
    { totalConsumed: 60 },
    [node('Home Solar', 80)], // 80 vs 40 prior => 2x
    [node('Home Solar', 40)],
  );
  assert.strictEqual(r.anomalies.length, 1);
  assert.strictEqual(r.anomalies[0].name, 'Home Solar');
  assert.ok(r.anomalies[0].reason.includes('100%'));
});

test('computeBillAnalysis yields null delta when prior period was zero', () => {
  const r = computeBillAnalysis({ totalConsumed: 50 }, { totalConsumed: 0 }, [], []);
  assert.strictEqual(r.deltaPercent, null);
  assert.strictEqual(r.anomalies.length, 0); // prior 0 => cannot spike
});

test('computeBillAnalysis handles missing/empty inputs defensively', () => {
  const r = computeBillAnalysis(null, undefined, null, undefined);
  assert.strictEqual(r.totalConsumedKwh, 0);
  assert.strictEqual(r.priorPeriodConsumedKwh, 0);
  assert.strictEqual(r.deltaPercent, null);
  assert.deepStrictEqual(r.topNodes, []);
  assert.deepStrictEqual(r.anomalies, []);
});

test('computeBillAnalysis topNodes drops zero-consumption nodes', () => {
  const r = computeBillAnalysis(
    { totalConsumed: 10 },
    { totalConsumed: 0 },
    [node('Idle', 0), node('Live', 10)],
    [],
  );
  assert.strictEqual(r.topNodes.length, 1);
  assert.strictEqual(r.topNodes[0].name, 'Live');
});
