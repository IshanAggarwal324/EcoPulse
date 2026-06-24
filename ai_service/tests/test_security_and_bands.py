import math
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import ValidationError  # noqa: E402

from app.schemas import ForecastRequest  # noqa: E402


def _stub_tensorflow():
    """Make importing forecast_service work without a real TF install.

    ``_format_predictions`` never touches TF at runtime, but its module imports
    ``model_store`` which imports ``tensorflow.keras.models.load_model`` at load
    time. We stub that import so the band-formatting logic is testable in any
    environment (including ones with an incompatible TF/protobuf pairing).
    """
    if "tensorflow" in sys.modules:
        return
    tf = types.ModuleType("tensorflow")
    keras = types.ModuleType("tensorflow.keras")
    keras_models = types.ModuleType("tensorflow.keras.models")
    keras_models.load_model = lambda *a, **k: None
    keras.models = keras_models
    tf.keras = keras
    sys.modules["tensorflow"] = tf
    sys.modules["tensorflow.keras"] = keras
    sys.modules["tensorflow.keras.models"] = keras_models


class ModelVersionValidationTests(unittest.TestCase):
    def test_rejects_path_traversal(self):
        for bad in ["../etc/passwd", "a/b", "a\\b", "v1;rm -rf", "a b", "x" * 65]:
            with self.assertRaises(ValidationError, msg=f"expected reject for {bad!r}"):
                ForecastRequest(model_version=bad)

    def test_accepts_valid(self):
        req = ForecastRequest(model_version="20240102_000000")
        self.assertEqual(req.model_version, "20240102_000000")

    def test_blank_becomes_none(self):
        self.assertIsNone(ForecastRequest(model_version="   ").model_version)
        self.assertIsNone(ForecastRequest().model_version)

    def test_node_id_length_capped(self):
        with self.assertRaises(ValidationError):
            ForecastRequest(node_id="x" * 200)


class ConformalBandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _stub_tensorflow()
        from app.services.forecast_service import ForecastService  # noqa: F401
        cls.available = True

    def setUp(self):
        if not self.available:
            self.skipTest("TensorFlow unavailable — skipping band-formatting test")

    def _format(self, bands):
        from app.services.forecast_service import ForecastService
        from datetime import datetime
        preds = [[100.0, 50.0], [100.0, 50.0]]
        return ForecastService._format_predictions(preds, datetime(2024, 1, 1), bands=bands)

    def test_conformal_bands_symmetric_and_calibrated(self):
        bands = {"alpha": 0.1, "generation_margin": 5.0, "consumption_margin": 2.0}
        results = self._format(bands)
        self.assertAlmostEqual(results[0].confidence, 0.9, places=6)
        # margin grows with horizon: step 0 scale=1, step 1 scale=sqrt(2)
        self.assertAlmostEqual(results[0].generation_lower, 95.0, places=6)
        self.assertAlmostEqual(results[1].generation_lower, 100.0 - 5.0 * math.sqrt(2), places=6)
        # bands never invert (lower <= value <= upper)
        for r in results:
            self.assertLessEqual(r.generation_lower, r.predicted_generation)
            self.assertLessEqual(r.predicted_generation, r.generation_upper)

    def test_heuristic_fallback_when_no_bands(self):
        results = self._format(None)
        self.assertGreater(results[0].confidence, 0.5)


if __name__ == "__main__":
    unittest.main()
