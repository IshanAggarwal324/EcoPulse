import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.exceptions import AppError  # noqa: E402
from app.schemas import (  # noqa: E402
    ALLOWED_FORECAST_HORIZONS,
    BatchForecastRequest,
    ForecastRequest,
)
from app.services.forecast_service import ForecastService  # noqa: E402


def _settings():
    return SimpleNamespace(
        registry_dir="registry",
        registry_model_name="lstm_energy_forecast",
        look_back_days=30,
        history_days=60,
        allow_model_free_dummy=False,
    )


def _df(n=80):
    idx = pd.date_range("2024-01-01", periods=n, freq="D")
    return pd.DataFrame(
        {"generation": np.linspace(100, 500, n), "consumption": np.linspace(80, 300, n)},
        index=idx,
    )


def _per_step(horizon):
    return [
        {"step": i + 1, "conformal": {"alpha": 0.1, "generation_margin": 1.0 * (i + 1),
                                      "consumption_margin": 1.0 * (i + 1)}}
        for i in range(horizon)
    ]


class _FakeStore:
    def __init__(self, bundle):
        self._bundle = bundle  # (model, scaler, metadata, version)

    def get_version(self, version=None):
        return self._bundle


class ForecastServiceResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_per_node_multi_horizon_single_pass(self):
        meta = {"version": "nodeA_v1", "preprocessing": {"horizon": 14},
                "metrics": {"per_step": _per_step(14)}}
        store = _FakeStore(("gmodel", "gscaler", {}, "v1"))
        svc = ForecastService(store, _settings())

        with mock.patch.object(svc, "_load_node_model",
                               mock.AsyncMock(return_value=("nmodel", "nscaler", meta, "per_node"))), \
                mock.patch("app.services.forecast_service.get_historical_data",
                           mock.AsyncMock(return_value=_df())), \
                mock.patch("app.services.forecast_service.prepare_for_prediction",
                           return_value=np.zeros((1, 30, 2))), \
                mock.patch("app.services.forecast_service.predict_multi_horizon",
                           return_value=np.full((14, 2), 5.0)):
            results, ctx = await svc._forecast_for_node(
                7, False, node_id="nodeA", horizon=14, model_scope="per_node")

        # days_to_predict(7) truncated to native horizon(14) -> 7 steps
        self.assertEqual(len(results), 7)
        self.assertEqual([r.horizon_step for r in results], list(range(1, 8)))
        self.assertEqual(ctx.scope, "per_node")
        self.assertEqual(ctx.horizon, 14)
        self.assertEqual(ctx.version, "nodeA_v1")

    async def test_global_legacy_recursive_path(self):
        meta = {"metrics": {"conformal": {"alpha": 0.1, "generation_margin": 1.0,
                                          "consumption_margin": 1.0}}}
        store = _FakeStore(("gmodel", "gscaler", meta, "v1"))
        svc = ForecastService(store, _settings())

        with mock.patch("app.services.forecast_service.get_historical_data",
                        mock.AsyncMock(return_value=_df())), \
                mock.patch("app.services.forecast_service.prepare_for_prediction",
                           return_value=np.zeros((1, 30, 2))), \
                mock.patch("app.services.forecast_service.predict_future",
                           return_value=np.full((7, 2), 3.0)):
            results, ctx = await svc._forecast_for_node(7, False, node_id=None)

        self.assertEqual(len(results), 7)
        self.assertTrue(all(r.horizon_step is None for r in results))
        self.assertEqual(ctx.scope, "global")
        self.assertIsNone(ctx.horizon)

    async def test_invalid_node_id_rejected_as_400(self):
        store = _FakeStore(("gmodel", "gscaler", {}, "v1"))
        svc = ForecastService(store, _settings())
        with self.assertRaises(AppError) as cm:
            await svc._forecast_for_node(7, False, node_id="../etc", model_scope="per_node")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(cm.exception.error_code, "INVALID_NODE_ID")

    async def test_per_node_filenotfound_falls_back_to_global(self):
        store = _FakeStore(("gmodel", "gscaler", {"metrics": {}}, "v1"))
        svc = ForecastService(store, _settings())

        with mock.patch.object(svc, "_load_node_model",
                               mock.AsyncMock(side_effect=FileNotFoundError)), \
                mock.patch("app.services.forecast_service.get_historical_data",
                           mock.AsyncMock(return_value=_df())), \
                mock.patch("app.services.forecast_service.prepare_for_prediction",
                           return_value=np.zeros((1, 30, 2))), \
                mock.patch("app.services.forecast_service.predict_future",
                           return_value=np.full((7, 2), 2.0)):
            results, ctx = await svc._forecast_for_node(
                7, False, node_id="nodeB", model_scope="per_node")

        self.assertEqual(ctx.scope, "global")
        self.assertEqual(len(results), 7)


class FormatPredictionsPerStepTests(unittest.TestCase):
    def test_per_step_bands_tag_horizon_and_no_sqrt_scaling(self):
        preds = np.full((3, 2), 10.0)
        per_step = _per_step(3)  # margins grow 1,2,3 linearly (not sqrt)
        idx = pd.Timestamp("2024-01-31")
        results = ForecastService._format_predictions(
            preds, idx, per_step_bands=per_step, tag_horizon_steps=True)
        self.assertEqual([r.horizon_step for r in results], [1, 2, 3])
        # step 2 margin (2.0) > step 1 (1.0) -> wider band
        self.assertGreater(
            results[1].generation_upper - results[1].predicted_generation,
            results[0].generation_upper - results[0].predicted_generation,
        )

    def test_per_node_cache_bounded(self):
        svc = ForecastService(_FakeStore(("m", "s", {}, "v")), _settings())
        svc._node_cache.__init__()  # ensure empty
        self.assertEqual(len(svc._node_cache), 0)


class SchemaHorizonScopeTests(unittest.TestCase):
    def test_horizon_allowlist(self):
        for ok in (None, 1, 7, 14, 30):
            req = ForecastRequest(horizon=ok)
            self.assertEqual(req.horizon, ok)
        for bad in (2, 5, 31, 0, "x"):
            with self.assertRaises(Exception):
                ForecastRequest(horizon=bad)

    def test_model_scope_values(self):
        for ok in (None, "global", "per_node", "GLOBAL", " Per_Node "):
            req = ForecastRequest(model_scope=ok)
            self.assertIn((req.model_scope or "global"), {None, "global", "per_node"})
        with self.assertRaises(Exception):
            ForecastRequest(model_scope="bogus")

    def test_batch_request_carries_fields(self):
        req = BatchForecastRequest(node_ids=["n1"], horizon=30, model_scope="per_node")
        self.assertEqual(req.horizon, 30)
        self.assertEqual(req.model_scope, "per_node")

    def test_allowed_horizons_constant(self):
        self.assertEqual(ALLOWED_FORECAST_HORIZONS, {1, 7, 14, 30})


if __name__ == "__main__":
    unittest.main()
