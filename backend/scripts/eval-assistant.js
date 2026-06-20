/**
 * Sub-module 3.4.3 — assistant evaluation harness.
 *
 * Runs a set of golden questions through the deterministic part of the pipeline
 * (intent classification → retriever source-type mapping → source normalization)
 * and asserts each produces the expected source attribution types.
 *
 * CI-safe: uses MOCK fixtures for retriever output and doc chunks — no live
 * Gemini, Mongo, or Redis required. Run directly:
 *
 *   node scripts/eval-assistant.js
 *
 * Exits non-zero on any failure so it can gate CI.
 */
'use strict';

const { classifyIntent } = require('../services/intentClassifier');
const { normalizeSources, buildDocSources } = require('../controllers/assistantController');

// Mocked retriever outputs per intent (simulates what each retriever in
// retrievalService.js / assistantRetrievers.js returns as `sources`). This is
// the "recorded fixture" layer — it lets us assert attribution deterministically.
const MOCK_RETRIEVER_SOURCES = {
  bill_analysis: [{ type: 'bill', label: 'Bill analysis' }],
  node_detail: [{ type: 'reading', label: 'Recent readings (168h)' }],
  wallet_profit: [{ type: 'wallet', label: 'Wallet flow history' }],
  carbon: [{ type: 'carbon', label: 'Carbon credit stats' }],
  forecast: [{ type: 'forecast', label: '7-day forecast' }],
  trades: [{ type: 'trade', label: 'Trade stats' }],
  nodes: [{ type: 'nodes', label: 'User nodes' }],
  grid_energy: [{ type: 'reading', label: 'Grid energy totals' }],
  general: [],
  faq: [],
};

// Sub-module 3.1.5 — hybrid retrieval always fetches doc chunks; simulate that
// with a single curated doc fixture.
const MOCK_DOC_CHUNKS = [
  { docId: 'trading-guide.md', title: 'How to list energy' },
];

const GOLDEN = [
  { q: 'Why is my bill high this week?', expectIntent: 'bill_analysis', expectType: 'bill' },
  { q: 'How do I list energy for sale?', expectIntent: 'trades', expectType: 'trade' },
  { q: "What's my wallet profit?", expectIntent: 'wallet_profit', expectType: 'wallet' },
  { q: 'Show me the 7-day forecast', expectIntent: 'forecast', expectType: 'forecast' },
  { q: 'What are carbon credits?', expectIntent: 'carbon', expectType: 'carbon' },
  { q: 'How much energy did I use this week?', expectIntent: 'bill_analysis', expectType: 'bill' },
  { q: 'Give me details for my solar node', expectIntent: 'node_detail', expectType: 'reading' },
];

function runHarness() {
  const results = [];
  let passed = 0;

  for (const { q, expectIntent, expectType } of GOLDEN) {
    const { intent } = classifyIntent(q);
    const retrieverSources = MOCK_RETRIEVER_SOURCES[intent] || [];
    // Hybrid retrieval (3.1.5): doc chunks are always fetched.
    const docSources = buildDocSources(MOCK_DOC_CHUNKS);
    const sources = normalizeSources([...retrieverSources, ...docSources]);
    const types = sources.map((s) => s.type);

    const intentOk = intent === expectIntent;
    const typeOk = types.includes(expectType);
    const docOk = types.includes('doc'); // hybrid retrieval guarantee

    const ok = intentOk && typeOk && docOk;
    if (ok) passed += 1;
    results.push({ q, intent, expectIntent, types, expectType, ok, intentOk, typeOk, docOk });
  }

  return { passed, total: GOLDEN.length, results };
}

function main() {
  const { passed, total, results } = runHarness();
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] "${r.q}" -> intent=${r.intent} types=[${r.types.join(',')}]`);
    if (!r.ok) {
      if (!r.intentOk) console.log(`    intent: expected ${r.expectIntent}`);
      if (!r.typeOk) console.log(`    missing expected source type: ${r.expectType}`);
      if (!r.docOk) console.log('    missing doc source (hybrid retrieval)');
    }
  }
  console.log(`\n${passed}/${total} golden questions passed`);
  if (passed !== total) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { runHarness, GOLDEN, MOCK_RETRIEVER_SOURCES };
