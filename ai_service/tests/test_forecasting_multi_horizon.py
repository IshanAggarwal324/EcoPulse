import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import forecasting as fc  # noqa: E402


class _StubModel:
    """Mimics keras model.predict — returns a fixed (1, width) array."""
    def __init__(self, width, fill=0.5):
        self.width = width
        self.fill = fill

    def predict(self, x, verbose=0):  # noqa: ARG002
        return np.full((1, self.width), self.fill, dtype=float)


class _StubScaler:
    """Identity inverse transform for a 2-column array."""
    def inverse_transform(self, arr):
        return np.asarray(arr, dtype=float)


class PredictMultiHorizonTests(unittest.TestCase):
    def test_shape_and_steps(self):
        horizon = 7
        model = _StubModel(horizon * 2)
        out = fc.predict_multi_horizon(model, np.zeros((1, 30, 2)), horizon, _StubScaler())
        self.assertEqual(out.shape, (horizon, 2))

    def test_width_mismatch_raises(self):
        # model trained for horizon=1 but called with horizon=14
        model = _StubModel(2)
        with self.assertRaises(ValueError):
            fc.predict_multi_horizon(model, np.zeros((1, 30, 2)), 14, _StubScaler())

    def test_invalid_horizon(self):
        with self.assertRaises(ValueError):
            fc.predict_multi_horizon(_StubModel(2), np.zeros((1, 30, 2)), 0, _StubScaler())

    def test_negatives_clipped_and_nan_sanitized(self):
        horizon = 3
        model = _StubModel(horizon * 2)

        class NegScaler:
            def inverse_transform(self, arr):
                arr = np.asarray(arr, dtype=float).copy()
                arr[0, 0] = -100.0      # negative -> clipped to 0
                arr[1, 1] = np.nan      # nan -> 0
                return arr

        out = fc.predict_multi_horizon(model, np.zeros((1, 30, 2)), horizon, NegScaler())
        self.assertGreaterEqual(out.min(), 0.0)
        self.assertFalse(np.isnan(out).any())
        self.assertEqual(out[0, 0], 0.0)
        self.assertEqual(out[1, 1], 0.0)


class BuildModelHorizonTests(unittest.TestCase):
    def test_invalid_horizon_raises(self):
        with self.assertRaises(ValueError):
            fc.build_model((30, 2), horizon=0)

    def test_valid_horizon_does_not_reject_argument(self):
        # Without TensorFlow installed this raises RuntimeError (import), not
        # ValueError (argument). We only assert horizon validation accepted.
        try:
            fc.build_model((30, 2), horizon=14)
        except RuntimeError:
            pass  # TF unavailable in this env — acceptable
        except ValueError:
            self.fail("horizon=14 should be accepted by build_model")


if __name__ == "__main__":
    unittest.main()
