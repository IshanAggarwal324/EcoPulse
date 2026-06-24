import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.anomaly_detection import (  # noqa: E402
    build_model,
    detect,
    score,
    train_model,
)
from models.anomaly_preprocessing import (  # noqa: E402
    FEATURE_COLUMNS,
    build_feature_frame,
)


@unittest.skipUnless(
    True,
    "scikit-learn may be absent in CI",
)
class AnomalyDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import sklearn  # noqa: F401
        except Exception:
            raise unittest.SkipTest("scikit-learn not installed")
        rng = np.random.default_rng(42)
        n = 120
        gen = rng.normal(50, 4, n)
        cons = rng.normal(30, 3, n)
        # Inject gross outliers (impossible jumps / negative generation).
        gen[60] = 5000.0
        cons[60] = -200.0
        gen[100] = 0.0
        cons[100] = 900.0
        idx = pd.date_range("2026-01-01", periods=n, freq="D")
        cls.df = pd.DataFrame({"generation": gen, "consumption": cons}, index=idx)
        cls.frame = build_feature_frame(cls.df, window=7)
        cls.X = cls.frame[FEATURE_COLUMNS].to_numpy(dtype=float)
        cls.model = build_model(contamination=0.05, random_state=42, n_estimators=80)
        cls.calib = train_model(cls.model, cls.X)

    def test_scores_in_unit_interval(self):
        s = score(self.model, self.X, self.calib)
        self.assertTrue(np.all(s >= 0.0))
        self.assertTrue(np.all(s <= 1.0))

    def test_outliers_scored_higher_than_typical(self):
        s = score(self.model, self.X, self.calib)
        typical = float(np.median(s))
        self.assertGreater(float(s[60]), typical)
        self.assertGreater(float(s[100]), typical)

    def test_detect_returns_flagged_with_reason_codes(self):
        flagged = detect(
            self.model,
            self.frame,
            calib=self.calib,
            threshold=0.5,
            zcap=3.0,
            max_results=50,
        )
        self.assertGreater(len(flagged), 0)
        reasons = {c for f in flagged for c in f["reason_codes"]}
        # Physical impossibilities (negative generation / huge jump) must surface.
        self.assertTrue(reasons & {"negative_generation", "negative_consumption", "generation_jump", "consumption_jump"})
        for f in flagged:
            self.assertTrue(0.0 <= f["anomaly_score"] <= 1.0)

    def test_detect_respects_max_results(self):
        flagged = detect(
            self.model,
            self.frame,
            calib=self.calib,
            threshold=0.0,
            zcap=0.0,
            max_results=3,
        )
        self.assertLessEqual(len(flagged), 3)

    def test_detect_empty_frame(self):
        empty = build_feature_frame(
            pd.DataFrame(columns=["generation", "consumption"])
        )
        self.assertEqual(detect(self.model, empty, calib=self.calib), [])


if __name__ == "__main__":
    unittest.main()
