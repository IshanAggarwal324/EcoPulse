import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.preprocessing import (  # noqa: E402
    assert_valid_horizon,
    build_training_matrices,
    make_supervised,
)
import pandas as pd  # noqa: E402


class MakeSupervisedHorizonTests(unittest.TestCase):
    def _series(self, n):
        idx = pd.date_range("2024-01-01", periods=n, freq="D")
        return pd.DataFrame(
            {"generation": np.arange(n, dtype=float),
             "consumption": np.arange(n, dtype=float) * 2},
            index=idx,
        )

    def test_horizon_one_backward_compat(self):
        data = np.arange(40).reshape(20, 2).astype(float)
        X, y = make_supervised(data, look_back=5, horizon=1)
        self.assertEqual(X.shape, (15, 5, 2))
        self.assertEqual(y.shape, (15, 2))
        # first target is the row right after the first window
        np.testing.assert_array_equal(y[0], data[5])

    def test_horizon_three_vector_target(self):
        data = np.arange(40).reshape(20, 2).astype(float)
        look_back, horizon = 5, 3
        X, y = make_supervised(data, look_back=look_back, horizon=horizon)
        expected_samples = len(data) - look_back - horizon + 1
        self.assertEqual(X.shape, (expected_samples, look_back, 2))
        self.assertEqual(y.shape, (expected_samples, horizon * 2))
        # first target = rows 5,6,7 flattened
        np.testing.assert_array_equal(y[0], data[5:8].reshape(-1))

    def test_invalid_horizon_raises(self):
        with self.assertRaises(ValueError):
            make_supervised(np.zeros((10, 2)), look_back=3, horizon=0)

    def test_lookback_plus_horizon_too_large(self):
        data = np.zeros((6, 2))
        X, y = make_supervised(data, look_back=5, horizon=3)
        # 6 - 5 - 3 + 1 = -1 -> no samples
        self.assertEqual(len(X), 0)
        self.assertEqual(len(y), 0)


class AssertValidHorizonTests(unittest.TestCase):
    def test_allows_listed(self):
        self.assertEqual(assert_valid_horizon(7, (1, 7, 14, 30)), 7)

    def test_rejects_unlisted(self):
        for bad in (2, 5, 31, 0, 365):
            with self.assertRaises(ValueError):
                assert_valid_horizon(bad, (1, 7, 14, 30))

    def test_rejects_non_int(self):
        with self.assertRaises(ValueError):
            assert_valid_horizon("seven", (1, 7, 14, 30))


class BuildMatricesHorizonTests(unittest.TestCase):
    def test_meta_records_horizon(self):
        df = self._df(200)
        matrices, scaler, meta = build_training_matrices(df, look_back=30, horizon=14)
        self.assertEqual(meta["horizon"], 14)
        self.assertEqual(matrices["y_train"].shape[1], 14 * 2)
        self.assertEqual(matrices["X_train"].shape[2], 2)

    def _df(self, n):
        idx = pd.date_range("2024-01-01", periods=n, freq="D")
        return pd.DataFrame(
            {"generation": np.linspace(100, 500, n),
             "consumption": np.linspace(80, 300, n)},
            index=idx,
        )


if __name__ == "__main__":
    unittest.main()
