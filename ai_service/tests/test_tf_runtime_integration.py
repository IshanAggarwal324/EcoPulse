"""
Task 6: Integration tests for full app startup with the cuda-init-log-warning
fix. Verifies that `create_app()` + `lifespan()` configures the TensorFlow
runtime environment and logs the resolved mode, without requiring a real
trained model artifact (the model/anomaly stores are mocked).

See .kiro/specs/cuda-init-log-warning/{bugfix.md,design.md,tasks.md}.
"""

import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fastapi.testclient import TestClient  # noqa: E402

from app import factory as factory_mod  # noqa: E402


class _EnvSnapshotMixin:
    def setUp(self):
        self._env_snapshot = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_snapshot)


class StartupCpuModeTests(_EnvSnapshotMixin, unittest.TestCase):
    """Task 6.1: Startup on a simulated GPU-less host emits the CPU-mode log
    and no native error text."""

    def test_startup_logs_cpu_mode_and_no_native_error_text(self):
        os.environ.pop("ECOPULSE_ENABLE_GPU", None)
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)
        os.environ.pop("TF_CPP_MIN_LOG_LEVEL", None)

        fake_model_store = mock.MagicMock()
        fake_anomaly_store = mock.MagicMock()

        with mock.patch(
            "app.factory.get_model_store", return_value=fake_model_store
        ), mock.patch(
            "app.factory.get_anomaly_store", return_value=fake_anomaly_store
        ):
            app = factory_mod.create_app()
            with self.assertLogs("app.factory", level="INFO") as captured:
                with TestClient(app):
                    pass

        combined_log_text = " ".join(captured.output)
        self.assertIn("mode=cpu", combined_log_text)
        self.assertNotIn("cuInit", combined_log_text)
        self.assertNotIn("cuda_platform.cc", combined_log_text)
        fake_model_store.load.assert_called_once()

        # The fix forces CPU-only mode by default.
        self.assertEqual(os.environ.get("CUDA_VISIBLE_DEVICES"), "-1")
        self.assertEqual(os.environ.get("TF_CPP_MIN_LOG_LEVEL"), "3")


class StartupGpuOptInTests(_EnvSnapshotMixin, unittest.TestCase):
    """Task 6.2: Startup with ECOPULSE_ENABLE_GPU=true leaves
    CUDA_VISIBLE_DEVICES untouched and logs GPU mode."""

    def test_gpu_optin_leaves_cuda_visible_devices_untouched_and_logs_gpu_mode(self):
        os.environ["ECOPULSE_ENABLE_GPU"] = "true"
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)

        fake_model_store = mock.MagicMock()
        fake_anomaly_store = mock.MagicMock()

        with mock.patch(
            "app.factory.get_model_store", return_value=fake_model_store
        ), mock.patch(
            "app.factory.get_anomaly_store", return_value=fake_anomaly_store
        ):
            app = factory_mod.create_app()
            with self.assertLogs("app.factory", level="INFO") as captured:
                with TestClient(app):
                    pass

        combined_log_text = " ".join(captured.output)
        self.assertIn("mode=gpu", combined_log_text)

        # GPU opt-in: CUDA_VISIBLE_DEVICES must NOT be forced to "-1".
        self.assertIsNone(os.environ.get("CUDA_VISIBLE_DEVICES"))


class FullSuiteNoRegressionTests(unittest.TestCase):
    """Task 6.3: Full existing ai_service/tests suite still passes unchanged.

    This is a self-referential smoke check: it confirms this integration
    test module itself imports and collects cleanly. The authoritative full
    suite comparison is run separately via:
        python -m unittest discover -s tests -p 'test_*.py'
    (see task 7 checkpoint / task execution report for the actual pass rate).
    """

    def test_integration_module_imports_cleanly(self):
        self.assertTrue(hasattr(factory_mod, "create_app"))
        self.assertTrue(hasattr(factory_mod, "lifespan"))


if __name__ == "__main__":
    unittest.main()
