import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.anomaly_preprocessing import (  # noqa: E402
    FEATURE_COLUMNS,
    build_feature_frame,
    feature_matrix,
    reason_codes_for_row,
)


def _frame(values):
    idx = pd.date_range("2026-01-01", periods=len(values), freq="D")
    return pd.DataFrame(
        {
            "generation": [g for g, _ in values],
            "consumption": [c for _, c in values],
        },
        index=idx,
    )


class BuildFeatureFrameTests(unittest.TestCase):
    def test_has_all_feature_columns(self):
        frame = build_feature_frame(_frame([(10, 5)] * 20), window=7)
        for col in FEATURE_COLUMNS:
            self.assertIn(col, frame.columns)
        self.assertIn("generation", frame.columns)
        self.assertIn("consumption", frame.columns)

    def test_empty_input_returns_empty_frame(self):
        empty = pd.DataFrame(columns=["generation", "consumption"])
        self.assertEqual(len(build_feature_frame(empty)), 0)

    def test_no_nan_or_inf_after_build(self):
        frame = build_feature_frame(
            _frame([(10, 5), (10, 5), (0, 0), (20, 15), (12, 6)]), window=3
        )
        arr = frame[FEATURE_COLUMNS].to_numpy()
        self.assertFalse(bool(np.isinf(arr).any()))
        self.assertFalse(bool(frame[FEATURE_COLUMNS].isna().any().any()))

    def test_feature_matrix_shape(self):
        frame = build_feature_frame(_frame([(10, 5)] * 12), window=5)
        self.assertEqual(feature_matrix(frame).shape, (12, len(FEATURE_COLUMNS)))

    def test_extreme_deltas_are_clipped(self):
        frame = build_feature_frame(_frame([(0, 0), (1e9, 1e9)]), window=2)
        dod = frame["gen_dod"].to_numpy()
        self.assertTrue(np.all(np.isfinite(dod)))
        self.assertTrue(np.all(dod <= 50))


class ReasonCodeTests(unittest.TestCase):
    def test_negative_generation_flagged(self):
        self.assertIn("negative_generation", reason_codes_for_row(-1, 5, 0, 0, 0, 0))

    def test_negative_consumption_flagged(self):
        self.assertIn("negative_consumption", reason_codes_for_row(10, -3, 0, 0, 0, 0))

    def test_consumption_spike_flagged(self):
        codes = reason_codes_for_row(10, 100, 0, 5, 0, 0, zcap=3)
        self.assertIn("consumption_spike", codes)

    def test_jump_ratio_flagged(self):
        self.assertIn("generation_jump", reason_codes_for_row(10, 5, 0, 0, 5, 0, zcap=3))

    def test_normal_reading_has_no_codes(self):
        self.assertEqual(reason_codes_for_row(10, 5, 0.5, 0.5, 1, 1, zcap=3), [])


if __name__ == "__main__":
    unittest.main()
