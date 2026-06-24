import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import model_registry as mr  # noqa: E402


class _StubModel:
    """Keras-free stand-in: save() writes placeholder bytes."""
    def save(self, path):
        with open(path, "wb") as f:
            f.write(b"stub-model")


class SafeComponentTests(unittest.TestCase):
    def test_rejects_traversal(self):
        for bad in ["..", "../x", "a/b", "a\\b", "a\x00b", "", None]:
            with self.assertRaises((ValueError, TypeError)):
                mr._assert_safe_component(bad, "version")

    def test_accepts_safe(self):
        self.assertEqual(mr._assert_safe_component("20240101_120000", "version"), "20240101_120000")
        self.assertEqual(mr._assert_safe_component("v-1_2", "version"), "v-1_2")


class SaveBundlePromoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.registry = os.path.join(self.tmp, "registry")
        self.model_name = "lstm_energy_forecast"

    def _save(self, version, promote):
        return mr.save_bundle(
            model=_StubModel(),
            scaler={"kind": "minmax"},
            preprocessing_meta={"look_back": 30, "n_rows": 100},
            training_meta={"epochs": 1, "data_source": "live"},
            metrics={"n_samples": 5, "mape_generation": 4.0, "mape_consumption": 6.0,
                     "conformal": {"alpha": 0.1, "generation_margin": 1.0, "consumption_margin": 1.0}},
            registry_dir=self.registry,
            model_name=self.model_name,
            version=version,
            promote=promote,
        )

    def test_promote_false_does_not_set_latest(self):
        v = self._save("20240101_000000", promote=False)
        self.assertEqual(v, "20240101_000000")
        latest = mr.get_latest(os.path.join(self.registry, self.model_name))
        self.assertIsNone(latest)
        # metadata still written
        meta = mr.read_metadata(registry_dir=self.registry, model_name=self.model_name, version=v)
        self.assertEqual(meta["metrics"]["mape_generation"], 4.0)
        self.assertEqual(meta["training"]["data_source"], "live")

    def test_promote_true_sets_latest(self):
        v = self._save("20240102_000000", promote=True)
        self.assertEqual(mr.get_latest(os.path.join(self.registry, self.model_name)), v)

    def test_save_rejects_traversal_version(self):
        with self.assertRaises(ValueError):
            self._save("../evil", promote=False)

    def test_list_versions(self):
        self._save("20240101_000000", promote=False)
        self._save("20240102_000000", promote=True)
        versions = mr.list_versions(registry_dir=self.registry, model_name=self.model_name)
        self.assertEqual(len(versions), 2)
        # sorted desc by saved_at_utc (equal here) -> stable; latest flagged promoted
        promoted_flags = [entry["promoted"] for entry in versions]
        self.assertIn(True, promoted_flags)
        self.assertEqual(versions[0]["data_source"], "live")

    def test_read_metadata_missing_raises(self):
        with self.assertRaises(FileNotFoundError):
            mr.read_metadata(registry_dir=self.registry, model_name=self.model_name, version="nope")


if __name__ == "__main__":
    unittest.main()
