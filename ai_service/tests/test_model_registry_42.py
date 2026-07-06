import json
import os
import sys
import tempfile
import types
import unittest
import zipfile

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


class LoadKerasModelTolerantTests(unittest.TestCase):
    """The tolerant loader must survive train/serve Keras version skew
    ("Unrecognized keyword arguments" -> strip ``quantization_config``) and
    must not trip on an out-of-scope exception variable after the except block.
    """

    _TF_MODULES = ("tensorflow", "tensorflow.keras", "tensorflow.keras.models")

    def setUp(self):
        self._saved = {k: sys.modules.get(k) for k in self._TF_MODULES}
        self.tmp = tempfile.mkdtemp()
        self.keras_path = os.path.join(self.tmp, "model.keras")
        with zipfile.ZipFile(self.keras_path, "w") as z:
            z.writestr(
                "config.json",
                json.dumps({
                    "class_name": "Sequential",
                    "config": {
                        "name": "seq",
                        "layers": [
                            {"class_name": "Dense",
                             "config": {"units": 2, "quantization_config": None}},
                        ],
                    },
                }),
            )
            z.writestr("model.weights.h5", b"weights")
            z.writestr("metadata.json", json.dumps({"keras_version": "3.14.1"}))

    def tearDown(self):
        for k, orig in self._saved.items():
            if orig is not None:
                sys.modules[k] = orig
            else:
                sys.modules.pop(k, None)

    def _install_fake_tf(self, load_model):
        tf = types.ModuleType("tensorflow")
        keras = types.ModuleType("tensorflow.keras")
        keras_models = types.ModuleType("tensorflow.keras.models")
        keras_models.load_model = load_model
        keras.models = keras_models
        tf.keras = keras
        sys.modules["tensorflow"] = tf
        sys.modules["tensorflow.keras"] = keras
        sys.modules["tensorflow.keras.models"] = keras_models

    def test_strips_forward_compat_keys_on_version_skew(self):
        calls = []

        def fake_load_model(path, *a, **k):
            calls.append(path)
            if len(calls) == 1:
                raise ValueError(
                    "Unrecognized keyword arguments passed to Dense: "
                    "{'quantization_config': None}"
                )
            # second call: the rebuilt archive must no longer carry the key
            with zipfile.ZipFile(path) as z:
                cfg = json.loads(z.read("config.json"))
            self.assertNotIn("quantization_config", json.dumps(cfg))
            return "MODEL_OK"

        self._install_fake_tf(fake_load_model)
        result = mr.load_keras_model(self.keras_path)

        self.assertEqual(result, "MODEL_OK")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], self.keras_path)
        self.assertNotEqual(calls[1], self.keras_path)

    def test_non_skew_error_is_reraised(self):
        self._install_fake_tf(lambda path, *a, **k: (_ for _ in ()).throw(FileNotFoundError("nope")))
        with self.assertRaises(FileNotFoundError):
            mr.load_keras_model(self.keras_path)

    def test_happy_path_no_retry(self):
        calls = []

        def fake_load_model(path, *a, **k):
            calls.append(path)
            return "MODEL_OK"

        self._install_fake_tf(fake_load_model)
        self.assertEqual(mr.load_keras_model(self.keras_path), "MODEL_OK")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
