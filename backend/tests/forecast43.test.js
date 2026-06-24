const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Module 4.3.7 — pricing engine consumes native multi-horizon output.
const pricingEngine = require('../services/pricing/pricingEngine');

const { normalizePrediction, fetchForecastCurve } = pricingEngine;

/* ------------------------------------------------------------------ */
/* normalizePrediction — native horizon_step pass-through              */
/* ------------------------------------------------------------------ */

test('normalizePrediction passes horizon_step through (native multi-horizon)', () => {
  const out = normalizePrediction({
    predicted_generation: 10,
    predicted_consumption: 5,
    confidence: 0.8,
    horizon_step: 14,
  });
  assert.strictEqual(out.forecastGen, 10);
  assert.strictEqual(out.horizonStep, 14);
});

test('normalizePrediction defaults horizon_step to null when absent', () => {
  const out = normalizePrediction({ predicted_generation: 1, predicted_consumption: 1 });
  assert.strictEqual(out.horizonStep, null);
});

/* ------------------------------------------------------------------ */
/* fetchForecastCurve — threads horizon/modelScope, surfaces scope     */
/* ------------------------------------------------------------------ */

const _originalFetch = global.fetch;

function _mockFetch(responsePayload, capture) {
  global.fetch = async (url, options) => {
    capture.url = url;
    capture.body = JSON.parse(options.body || '{}');
    return {
      ok: true,
      json: async () => responsePayload,
    };
  };
}

test('fetchForecastCurve sends horizon + model_scope and returns scope/horizon', async () => {
  const captured = {};
  _mockFetch(
    {
      predictions: [{ predicted_generation: 1, predicted_consumption: 1, confidence: 0.9, horizon_step: 1 }],
      model_status: 'ok',
      model_scope: 'per_node',
      horizon: 14,
    },
    captured,
  );

  try {
    const res = await fetchForecastCurve({ nodeId: 'abc', days: 14, horizon: 14, modelScope: 'per_node' });
    assert.strictEqual(captured.body.horizon, 14);
    assert.strictEqual(captured.body.model_scope, 'per_node');
    assert.strictEqual(captured.body.node_id, 'abc');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.modelScope, 'per_node');
    assert.strictEqual(res.horizon, 14);
    assert.strictEqual(res.predictions[0].horizon_step, 1);
  } finally {
    global.fetch = _originalFetch;
  }
});

test('fetchForecastCurve omits horizon/model_scope when not provided', async () => {
  const captured = {};
  _mockFetch({ predictions: [], model_status: 'ok' }, captured);
  try {
    await fetchForecastCurve({ nodeId: null, days: 7 });
    assert.ok(!('horizon' in captured.body));
    assert.ok(!('model_scope' in captured.body));
  } finally {
    global.fetch = _originalFetch;
  }
});

test('fetchForecastCurve degrades gracefully on fetch failure', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await fetchForecastCurve({ nodeId: 'x', days: 7, horizon: 7 });
    assert.strictEqual(res.available, false);
    assert.deepStrictEqual(res.predictions, []);
  } finally {
    global.fetch = _originalFetch;
  }
});
