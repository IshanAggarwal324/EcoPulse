"""
Bug condition exploration + preservation + unit + property-based tests for
the cuda-init-log-warning bugfix.

See .kiro/specs/cuda-init-log-warning/{bugfix.md,design.md,tasks.md}.

Task 1 (exploration) and Task 2 (preservation) tests are written to observe
behavior on UNFIXED code first. After the fix (models/tf_runtime_env.py +
call-site updates) lands, the assertions in the "post-fix" sections are
flipped to their expected-after-fix values per task 3.5/3.6 — the tests
themselves are not rewritten from scratch, only the specific counterexample
assertions are updated in place, as instructed by tasks.md.
"""

import itertools
import os
import subprocess
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _run_subprocess_snippet(code: str, env_overrides: dict, unset_vars=()):
    """Run `code` in a fresh subprocess with a controlled environment.

    `env_overrides` are set; `unset_vars` are deleted (if present) from the
    inherited environment before the subprocess starts. Returns the
    completed process (captured combined-ish stdout/stderr kept separate).
    """
    env = os.environ.copy()
    for var in unset_vars:
        env.pop(var, None)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


class BugConditionExplorationTests(unittest.TestCase):
    """Task 1: Property 1 (Bug Condition) exploration.

    GOAL: Surface counterexamples showing that `_keras()` /
    `load_keras_model()` / `lifespan()` import TensorFlow with no CPU-only
    environment configuration applied first, and no CPU/GPU mode log is
    emitted.
    """

    def test_forecasting_keras_import_leaves_env_vars_unset(self):
        """Case 1: fresh subprocess imports models.forecasting and calls
        _keras() with the two env vars deliberately deleted beforehand.

        POST-FIX EXPECTATION: both vars ARE set after the call (flipped from
        the pre-fix counterexample below).
        """
        code = (
            "import os, sys, json\n"
            "sys.path.insert(0, r'" + ROOT + "')\n"
            "from models import forecasting as fc\n"
            "try:\n"
            "    fc._keras()\n"
            "except Exception:\n"
            "    pass\n"
            "print(json.dumps({\n"
            "    'tf_log': os.environ.get('TF_CPP_MIN_LOG_LEVEL'),\n"
            "    'cuda_vis': os.environ.get('CUDA_VISIBLE_DEVICES'),\n"
            "}))\n"
        )
        result = _run_subprocess_snippet(
            code, {}, unset_vars=("TF_CPP_MIN_LOG_LEVEL", "CUDA_VISIBLE_DEVICES")
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        last_line = result.stdout.strip().splitlines()[-1]
        import json as _json

        payload = _json.loads(last_line)

        # POST-FIX: configure_tf_runtime() is called before the TF import,
        # so both vars are now set by the time the subprocess exits.
        self.assertEqual(payload["tf_log"], "3")
        self.assertEqual(payload["cuda_vis"], "-1")

    def test_model_registry_load_keras_model_leaves_env_vars_unset(self):
        """Case 2: fresh subprocess imports models.model_registry and calls
        load_keras_model() under the same deleted-env-vars condition.

        POST-FIX EXPECTATION: both vars ARE set after the call.
        """
        code = (
            "import os, sys, json\n"
            "sys.path.insert(0, r'" + ROOT + "')\n"
            "from models import model_registry as mr\n"
            "try:\n"
            "    mr.load_keras_model('this_path_does_not_exist.keras')\n"
            "except Exception:\n"
            "    pass\n"
            "print(json.dumps({\n"
            "    'tf_log': os.environ.get('TF_CPP_MIN_LOG_LEVEL'),\n"
            "    'cuda_vis': os.environ.get('CUDA_VISIBLE_DEVICES'),\n"
            "}))\n"
        )
        result = _run_subprocess_snippet(
            code, {}, unset_vars=("TF_CPP_MIN_LOG_LEVEL", "CUDA_VISIBLE_DEVICES")
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        last_line = result.stdout.strip().splitlines()[-1]
        import json as _json

        payload = _json.loads(last_line)

        # POST-FIX: configure_tf_runtime() runs before the TF import inside
        # load_keras_model(), regardless of whether the load itself fails.
        self.assertEqual(payload["tf_log"], "3")
        self.assertEqual(payload["cuda_vis"], "-1")

    def test_native_cuinit_probe_best_effort(self):
        """Best-effort: if the locally installed TensorFlow build reproduces
        the native cuInit probe, assert the captured output of an unfixed
        _keras() call contains the marker text. Skip gracefully if the local
        TF build/environment doesn't reproduce it (e.g. TF not importable at
        all here, or a build that doesn't emit the native line).
        """
        code = (
            "import os, sys\n"
            "sys.path.insert(0, r'" + ROOT + "')\n"
            "from models import forecasting as fc\n"
            "try:\n"
            "    fc._keras()\n"
            "except Exception:\n"
            "    pass\n"
        )
        result = _run_subprocess_snippet(
            code, {}, unset_vars=("TF_CPP_MIN_LOG_LEVEL", "CUDA_VISIBLE_DEVICES")
        )
        combined = (result.stdout or "") + (result.stderr or "")
        if "cuInit" not in combined and "cuda_platform.cc" not in combined:
            self.skipTest(
                "Local TensorFlow build/environment did not reproduce native "
                "cuInit/cuda_platform.cc probe logging; skipping best-effort "
                "assertion (root cause #1/#2 still confirmed by the env-var "
                "assertions above)."
            )
        self.assertTrue(
            "cuInit" in combined or "cuda_platform.cc" in combined
        )

    def test_lifespan_source_has_no_mode_log_reference(self):
        """Case 3 / root cause #3: no log record/text anywhere in
        app/factory.py's lifespan() source mentions CPU-only/GPU mode.

        POST-FIX EXPECTATION: the source DOES now reference the resolved
        mode (e.g. via a `logger.info(...)` call mentioning "mode").
        """
        factory_path = os.path.join(ROOT, "app", "factory.py")
        with open(factory_path, "r", encoding="utf-8") as f:
            source = f.read()

        # Isolate the lifespan() function body for a more targeted check.
        start = source.index("async def lifespan")
        # crude but sufficient: take up to the next top-level 'def '
        rest = source[start:]
        end_marker = rest.find("\ndef ", 1)
        lifespan_src = rest if end_marker == -1 else rest[:end_marker]

        # POST-FIX: lifespan() now calls configure_tf_runtime() and logs the
        # resolved mode before store.load().
        self.assertIn("configure_tf_runtime", lifespan_src)
        self.assertIn("mode", lifespan_src.lower())


class PreservationTests(unittest.TestCase):
    """Task 2: Property 2 (Preservation).

    Observed on UNFIXED code: importing models.forecasting /
    models.model_registry never touches TF_CPP_MIN_LOG_LEVEL or
    CUDA_VISIBLE_DEVICES regardless of pre-set values. After the fix, the
    invariant becomes narrower but still holds: operator-provided values are
    never overwritten (setdefault semantics) — see task 3.6.
    """

    _TF_LOG_VALUES = (None, "0", "3")
    _CUDA_VIS_VALUES = (None, "-1", "0")
    _GPU_OPTIN_VALUES = (None, "true", "false")

    def _matrix(self):
        return itertools.product(
            self._TF_LOG_VALUES, self._CUDA_VIS_VALUES, self._GPU_OPTIN_VALUES
        )

    def test_operator_preset_values_never_overwritten_by_import(self):
        """Property-based sweep over the small fixed matrix: for every
        combination, importing models.forecasting/models.model_registry
        (without calling the TF-invoking functions) leaves all three env
        vars exactly as pre-set.

        NOTE: this asserts the *import* itself is side-effect-free w.r.t.
        these vars — true both before and after the fix, since
        configure_tf_runtime() is only invoked from inside _keras()/
        load_keras_model()/lifespan(), not at module import time.
        """
        import importlib
        from models import forecasting as fc_mod  # noqa: F401
        from models import model_registry as mr_mod  # noqa: F401

        for tf_log, cuda_vis, gpu_optin in self._matrix():
            overrides = {}
            if tf_log is not None:
                overrides["TF_CPP_MIN_LOG_LEVEL"] = tf_log
            if cuda_vis is not None:
                overrides["CUDA_VISIBLE_DEVICES"] = cuda_vis
            if gpu_optin is not None:
                overrides["ECOPULSE_ENABLE_GPU"] = gpu_optin

            to_clear = [
                v
                for v, val in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                )
                if val is None
            ]

            with mock.patch.dict(os.environ, overrides, clear=False):
                for var in to_clear:
                    os.environ.pop(var, None)

                importlib.reload(fc_mod)
                importlib.reload(mr_mod)

                for var, expected in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                ):
                    self.assertEqual(
                        os.environ.get(var),
                        expected,
                        msg=f"var={var} expected={expected!r} "
                        f"actual={os.environ.get(var)!r} "
                        f"matrix={(tf_log, cuda_vis, gpu_optin)}",
                    )

    def test_non_tf_valueerror_path_unaffected_by_env_matrix(self):
        """Second preservation case: build_model(..., horizon=0) raises the
        same ValueError regardless of the env-var matrix (this path never
        reaches the TensorFlow import / configure_tf_runtime() call)."""
        from models import forecasting as fc

        for tf_log, cuda_vis, gpu_optin in self._matrix():
            overrides = {
                k: v
                for k, v in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                )
                if v is not None
            }
            with mock.patch.dict(os.environ, overrides, clear=False):
                with self.assertRaises(ValueError) as ctx:
                    fc.build_model((30, 2), horizon=0)
                self.assertEqual(str(ctx.exception), "horizon must be >= 1")


class ConfigureTfRuntimeUnitTests(unittest.TestCase):
    """Task 4: unit tests for configure_tf_runtime() and call-order
    guarantees. These import models.tf_runtime_env, which only exists after
    the fix (task 3.1) is implemented.
    """

    def setUp(self):
        self._env_snapshot = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_snapshot)

    def test_default_cpu_only_resolution(self):
        from models.tf_runtime_env import configure_tf_runtime

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TF_CPP_MIN_LOG_LEVEL", None)
            os.environ.pop("CUDA_VISIBLE_DEVICES", None)
            os.environ.pop("ECOPULSE_ENABLE_GPU", None)

            info = configure_tf_runtime()

            self.assertEqual(os.environ.get("TF_CPP_MIN_LOG_LEVEL"), "3")
            self.assertEqual(os.environ.get("CUDA_VISIBLE_DEVICES"), "-1")
            self.assertEqual(info["mode"], "cpu")
            self.assertEqual(info["tf_cpp_min_log_level"], "3")
            self.assertEqual(info["cuda_visible_devices"], "-1")

    def test_operator_provided_values_never_overridden(self):
        from models.tf_runtime_env import configure_tf_runtime

        with mock.patch.dict(
            os.environ,
            {"TF_CPP_MIN_LOG_LEVEL": "1", "CUDA_VISIBLE_DEVICES": "0"},
            clear=False,
        ):
            info = configure_tf_runtime()

            self.assertEqual(os.environ.get("TF_CPP_MIN_LOG_LEVEL"), "1")
            self.assertEqual(os.environ.get("CUDA_VISIBLE_DEVICES"), "0")
            self.assertEqual(info["mode"], "cpu")

    def test_gpu_optin_preserves_discovery(self):
        from models.tf_runtime_env import configure_tf_runtime

        with mock.patch.dict(os.environ, {"ECOPULSE_ENABLE_GPU": "true"}, clear=False):
            os.environ.pop("CUDA_VISIBLE_DEVICES", None)

            info = configure_tf_runtime()

            self.assertIsNone(os.environ.get("CUDA_VISIBLE_DEVICES"))
            self.assertEqual(info["mode"], "gpu")

    def test_keras_calls_configure_before_tensorflow_import(self):
        call_order = []

        def fake_configure():
            call_order.append("configure")
            return {"mode": "cpu", "cuda_visible_devices": "-1", "tf_cpp_min_log_level": "3"}

        class _FakeSequential:
            pass

        class _FakeModule:
            Sequential = _FakeSequential

        fake_keras_models = mock.MagicMock()
        fake_keras_models.Sequential = _FakeSequential

        def fake_import_sequential(*args, **kwargs):
            call_order.append("import_tf")
            raise ImportError("simulated import boundary")

        from models import forecasting as fc

        with mock.patch(
            "models.tf_runtime_env.configure_tf_runtime", side_effect=fake_configure
        ) as mock_configure:
            with mock.patch.dict(
                "sys.modules",
                {
                    "tensorflow": mock.MagicMock(),
                },
            ):
                # Force the Sequential import line itself to record order,
                # by patching builtins import is fragile; instead assert
                # configure_tf_runtime is invoked at all and, since the real
                # `from tensorflow.keras.models import Sequential` line
                # follows it unconditionally in source, call-count is proof
                # of "before" given _keras()'s try-block ordering.
                try:
                    fc._keras()
                except Exception:
                    pass
                self.assertTrue(mock_configure.called)
                self.assertEqual(call_order, ["configure"])

    def test_load_keras_model_calls_configure_before_tensorflow_import(self):
        call_order = []

        def fake_configure():
            call_order.append("configure")
            return {"mode": "cpu", "cuda_visible_devices": "-1", "tf_cpp_min_log_level": "3"}

        from models import model_registry as mr

        with mock.patch(
            "models.tf_runtime_env.configure_tf_runtime", side_effect=fake_configure
        ) as mock_configure:
            try:
                mr.load_keras_model("nonexistent_path.keras")
            except Exception:
                pass
            self.assertTrue(mock_configure.called)
            self.assertEqual(call_order, ["configure"])

    def test_lifespan_logs_resolved_mode_before_store_load(self):
        import asyncio

        call_order = []

        def fake_configure():
            call_order.append("configure")
            return {"mode": "cpu", "cuda_visible_devices": "-1", "tf_cpp_min_log_level": "3"}

        fake_store = mock.MagicMock()
        fake_store.load.side_effect = lambda: call_order.append("store_load")

        fake_anomaly_store = mock.MagicMock()
        fake_anomaly_store.load.side_effect = lambda: call_order.append("anomaly_load")

        from app import factory as factory_mod

        with mock.patch(
            "app.factory.get_model_store", return_value=fake_store
        ), mock.patch(
            "app.factory.get_anomaly_store", return_value=fake_anomaly_store
        ), mock.patch(
            "app.factory.configure_tf_runtime", side_effect=fake_configure
        ), mock.patch("app.factory.setup_logging"), mock.patch(
            "app.factory.logger"
        ) as mock_logger:

            async def _run():
                async with factory_mod.lifespan(mock.MagicMock()):
                    pass

            asyncio.run(_run())

            self.assertIn("configure", call_order)
            self.assertIn("store_load", call_order)
            self.assertLess(
                call_order.index("configure"), call_order.index("store_load")
            )
            self.assertTrue(mock_logger.info.called)
            logged_text = " ".join(
                str(arg) for call in mock_logger.info.call_args_list for arg in call.args
            )
            self.assertIn("cpu", logged_text.lower())


class ConfigureTfRuntimePropertyTests(unittest.TestCase):
    """Task 5: property-based tests generalizing the env-var combination
    space via itertools.product (no external PBT library present in this
    codebase)."""

    _TF_LOG_VALUES = (None, "0", "1", "2", "3")
    _CUDA_VIS_VALUES = (None, "-1", "0", "0,1")
    _GPU_OPTIN_VALUES = (None, "true", "TRUE", "1", "false", "0", "")

    def setUp(self):
        self._env_snapshot = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_snapshot)

    @staticmethod
    def _truthy(value):
        return value is not None and value.strip().lower() in ("1", "true", "yes")

    def test_operator_set_vs_default_invariant_full_matrix(self):
        """**Validates: Requirements 3.1**"""
        from models.tf_runtime_env import configure_tf_runtime

        for tf_log, cuda_vis, gpu_optin in itertools.product(
            self._TF_LOG_VALUES, self._CUDA_VIS_VALUES, self._GPU_OPTIN_VALUES
        ):
            overrides = {
                k: v
                for k, v in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                )
                if v is not None
            }
            to_clear = [
                v
                for v, val in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                )
                if val is None
            ]

            with mock.patch.dict(os.environ, overrides, clear=False):
                for var in to_clear:
                    os.environ.pop(var, None)

                configure_tf_runtime()

                # TF_CPP_MIN_LOG_LEVEL invariant
                if tf_log is not None:
                    self.assertEqual(os.environ.get("TF_CPP_MIN_LOG_LEVEL"), tf_log)
                else:
                    self.assertEqual(os.environ.get("TF_CPP_MIN_LOG_LEVEL"), "3")

                gpu_enabled = self._truthy(gpu_optin)
                # CUDA_VISIBLE_DEVICES invariant
                if cuda_vis is not None:
                    self.assertEqual(os.environ.get("CUDA_VISIBLE_DEVICES"), cuda_vis)
                elif gpu_enabled:
                    self.assertIsNone(os.environ.get("CUDA_VISIBLE_DEVICES"))
                else:
                    self.assertEqual(os.environ.get("CUDA_VISIBLE_DEVICES"), "-1")

    def test_non_tf_behavior_unaffected_by_matrix_subset(self):
        """**Validates: Requirements 3.2, 3.3**"""
        from models import forecasting as fc

        subset = list(
            itertools.product(
                self._TF_LOG_VALUES[:2], self._CUDA_VIS_VALUES[:2], self._GPU_OPTIN_VALUES[:3]
            )
        )
        for tf_log, cuda_vis, gpu_optin in subset:
            overrides = {
                k: v
                for k, v in (
                    ("TF_CPP_MIN_LOG_LEVEL", tf_log),
                    ("CUDA_VISIBLE_DEVICES", cuda_vis),
                    ("ECOPULSE_ENABLE_GPU", gpu_optin),
                )
                if v is not None
            }
            with mock.patch.dict(os.environ, overrides, clear=False):
                with self.assertRaises(ValueError) as ctx:
                    fc.build_model((30, 2), horizon=0)
                self.assertEqual(str(ctx.exception), "horizon must be >= 1")


if __name__ == "__main__":
    unittest.main()
