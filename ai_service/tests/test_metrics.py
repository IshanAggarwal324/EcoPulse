import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.metrics import aggregate_mape, evaluate_holdout  # noqa: E402


class _IdentityScaler:
    def inverse_transform(self, values):
        return np.asarray(values, dtype=float)


class _StubModel:
    def __init__(self, preds):
        self._preds = np.asarray(preds, dtype=float)

    def predict(self, X, verbose=0):  # noqa: A002 - mirrors keras signature
        return self._preds


class EvaluateHoldoutTests(unittest.TestCase):
    def test_empty_holdout_returns_zero_samples(self):
        metrics = evaluate_holdout(
            _StubModel(np.zeros((1, 2))),
            np.empty((0, 3, 2)),
            np.empty((0, 2)),
            _IdentityScaler(),
        )
        self.assertEqual(metrics["n_samples"], 0)
        self.assertNotIn("conformal", metrics)

    def test_perfect_predictions_zero_mape(self):
        actuals = np.array([[10.0, 5.0], [20.0, 8.0], [15.0, 3.0]])
        model = _StubModel(actuals)
        metrics = evaluate_holdout(model, np.zeros((3, 3, 2)), actuals, _IdentityScaler())
        self.assertEqual(metrics["n_samples"], 3)
        self.assertAlmostEqual(metrics["mape_generation"], 0.0, places=6)
        self.assertAlmostEqual(metrics["mape_consumption"], 0.0, places=6)
        self.assertAlmostEqual(metrics["conformal"]["generation_margin"], 0.0, places=6)

    def test_constant_offset_margins_and_mape(self):
        actuals = np.array([[100.0, 50.0], [100.0, 50.0], [100.0, 50.0]])
        preds = actuals + 10.0  # constant +10 error
        model = _StubModel(preds)
        metrics = evaluate_holdout(model, np.zeros((3, 3, 2)), actuals, _IdentityScaler(), alpha=0.1)
        # 10% MAPE on both features
        self.assertAlmostEqual(metrics["mape_generation"], 10.0, places=4)
        self.assertAlmostEqual(metrics["mape_consumption"], 20.0, places=4)
        # 90th percentile of |err|=10 is 10
        self.assertAlmostEqual(metrics["conformal"]["generation_margin"], 10.0, places=6)
        self.assertAlmostEqual(metrics["conformal"]["consumption_margin"], 10.0, places=6)
        # coverage: all errors (10) <= margin (10)
        self.assertAlmostEqual(metrics["conformal"]["generation_coverage"], 1.0, places=6)

    def test_aggregate_mape_handles_missing(self):
        self.assertIsNone(aggregate_mape({}))
        self.assertIsNone(aggregate_mape({"mape_generation": 5.0}))
        self.assertAlmostEqual(aggregate_mape({"mape_generation": 4.0, "mape_consumption": 6.0}), 5.0)


if __name__ == "__main__":
    unittest.main()
