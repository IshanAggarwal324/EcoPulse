import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import node_model_registry as nmr  # noqa: E402
from models import model_registry as mr  # noqa: E402


class _StubModel:
    def save(self, path):
        with open(path, "wb") as f:
            f.write(b"stub-node-model")


class NodeIdSafetyTests(unittest.TestCase):
    def test_rejects_traversal(self):
        for bad in ["..", "../x", "a/b", "a\\b", "a\x00b", "", None, "a b",
                    "node.x", "café", "x" * 65, "node;rm"]:
            with self.assertRaises((ValueError, TypeError)):
                nmr.assert_safe_node_id(bad)

    def test_accepts_safe(self):
        for ok in ["abc123", "507f1f77bcf86cd799439011", "node-1_2"]:
            self.assertEqual(nmr.assert_safe_node_id(ok), ok)


class NodeBundleSaveListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.registry = os.path.join(self.tmp, "registry")
        self.model_name = "lstm_energy_forecast"

    def test_save_and_list_versions(self):
        v1 = nmr.save_node_bundle(
            node_id="nodeA", model=_StubModel(), scaler={"k": 1},
            preprocessing_meta={"horizon": 14, "n_rows": 100},
            training_meta={"data_source": "live"},
            metrics={"n_samples": 5, "mape_generation": 4.0, "mape_consumption": 6.0},
            registry_dir=self.registry, model_name=self.model_name, version="v1",
        )
        self.assertEqual(v1, "v1")
        versions = nmr.list_node_versions("nodeA", registry_dir=self.registry, model_name=self.model_name)
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions[0]["version"], "v1")
        self.assertEqual(versions[0]["horizon"], 14)
        self.assertTrue(versions[0]["promoted"])

    def test_isolated_per_node_dir(self):
        nmr.save_node_bundle(node_id="nodeA", model=_StubModel(), scaler={},
                             preprocessing_meta={}, training_meta={},
                             registry_dir=self.registry, model_name=self.model_name, version="v1")
        nmr.save_node_bundle(node_id="nodeB", model=_StubModel(), scaler={},
                             preprocessing_meta={}, training_meta={},
                             registry_dir=self.registry, model_name=self.model_name, version="v1")
        # nodeA and nodeB must not share a directory
        self.assertNotEqual(
            nmr.list_node_versions("nodeA", registry_dir=self.registry, model_name=self.model_name),
            [],
        )
        # Writing nodeB must not affect nodeA's LATEST
        self.assertEqual(nmr.get_latest_node_version("nodeA", registry_dir=self.registry,
                                                     model_name=self.model_name), "v1")


class LoadFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.registry = os.path.join(self.tmp, "registry")
        self.model_name = "lstm_energy_forecast"
        # Pre-seed a global model so fallback has something to find.
        mr.save_bundle(model=_StubModel(), scaler={"k": "global"},
                       preprocessing_meta={"horizon": 1}, training_meta={},
                       metrics={"n_samples": 1, "mape_generation": 1.0, "mape_consumption": 1.0},
                       registry_dir=self.registry, model_name=self.model_name, version="gv1")

    def test_falls_back_to_global_when_missing(self):
        with mock.patch("tensorflow.keras.models.load_model", return_value="GLOBAL_MODEL"):
            model, scaler, meta, scope = nmr.load_node_bundle(
                node_id="no_such_node", registry_dir=self.registry, model_name=self.model_name,
            )
        self.assertEqual(scope, "global")
        self.assertEqual(model, "GLOBAL_MODEL")
        self.assertEqual(scaler["k"], "global")

    def test_no_fallback_raises(self):
        with self.assertRaises(FileNotFoundError):
            nmr.load_node_bundle(
                node_id="no_such_node", registry_dir=self.registry, model_name=self.model_name,
                fallback_to_global=False,
            )

    def test_loads_per_node_when_present(self):
        nmr.save_node_bundle(node_id="nodeA", model=_StubModel(), scaler={"k": "nodeA"},
                             preprocessing_meta={"horizon": 14}, training_meta={},
                             metrics={"n_samples": 1, "mape_generation": 1.0, "mape_consumption": 1.0},
                             registry_dir=self.registry, model_name=self.model_name, version="v1")
        with mock.patch("tensorflow.keras.models.load_model", return_value="NODE_MODEL"):
            model, scaler, meta, scope = nmr.load_node_bundle(
                node_id="nodeA", registry_dir=self.registry, model_name=self.model_name,
            )
        self.assertEqual(scope, "per_node")
        self.assertEqual(scaler["k"], "nodeA")
        self.assertEqual(meta["scope"], "per_node")


if __name__ == "__main__":
    unittest.main()
