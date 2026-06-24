import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.model_registry import (  # noqa: E402
    get_latest,
    load_anomaly_bundle,
    save_anomaly_bundle,
)


class AnomalyRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_round_trip_and_latest_pointer(self):
        model = {"type": "dummy_if", "fitted": True}
        cfg = {
            "feature_columns": ["a", "b"],
            "calibration": {"lo": 0.0, "hi": 1.0},
            "threshold": 0.7,
        }
        version = save_anomaly_bundle(
            model=model,
            feature_config=cfg,
            training_meta={"rows": 100},
            registry_dir=self.tmp,
            model_name="meter_anomaly_detector",
        )
        self.assertTrue(version)
        self.assertEqual(
            get_latest(os.path.join(self.tmp, "meter_anomaly_detector")), version
        )
        loaded_model, loaded_cfg, meta = load_anomaly_bundle(
            registry_dir=self.tmp, model_name="meter_anomaly_detector"
        )
        self.assertEqual(loaded_model, model)
        self.assertEqual(loaded_cfg["threshold"], 0.7)
        self.assertEqual(meta["version"], version)
        self.assertEqual(meta["framework"], "sklearn")

    def test_explicit_version_load(self):
        model = {"x": 1}
        save_anomaly_bundle(
            model=model,
            feature_config={"k": 1},
            training_meta={},
            registry_dir=self.tmp,
            model_name="m",
            version="20260101_000000",
        )
        loaded, _, _ = load_anomaly_bundle(
            registry_dir=self.tmp, model_name="m", version="20260101_000000"
        )
        self.assertEqual(loaded, model)

    def test_load_missing_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_anomaly_bundle(registry_dir=self.tmp, model_name="does_not_exist")

    def test_path_traversal_rejected_on_save(self):
        with self.assertRaises(ValueError):
            save_anomaly_bundle(
                model={"a": 1},
                feature_config={},
                training_meta={},
                registry_dir=self.tmp,
                model_name="../escape",
            )

    def test_path_traversal_rejected_on_load(self):
        with self.assertRaises(ValueError):
            load_anomaly_bundle(
                registry_dir=self.tmp, model_name="ok", version="../../etc/passwd"
            )


if __name__ == "__main__":
    unittest.main()
