import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from train_node import PerNodeReport, run_per_node_training  # noqa: E402


def _settings(**kw):
    base = dict(
        registry_dir="registry",
        registry_model_name="lstm_energy_forecast",
        look_back_days=10,
        node_min_history_days=60,
        node_max_train_per_run=2,
        forecast_horizons=(1, 7, 14, 30),
        default_horizon=14,
        conformal_alpha=0.1,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _df(n):
    idx = pd.date_range("2024-01-01", periods=n, freq="D")
    import numpy as np
    return pd.DataFrame(
        {"generation": np.linspace(100, 500, n), "consumption": np.linspace(80, 300, n)},
        index=idx,
    )


class _StubModel:
    def save(self, path):
        with open(path, "wb") as f:
            f.write(b"stub")


async def _ok_node_training(node_id, *, settings=None, horizon=None, promote=True):
    from train_node import NodeTrainingResult
    return NodeTrainingResult(node_id=node_id, status="trained", version="v1",
                              horizon=horizon, n_rows=100, mape=5.0)


class PerNodeBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_caps_node_count(self):
        settings = _settings(node_max_train_per_run=2)
        nodes = [{"node_id": f"node{i}", "date_span_days": 90, "total_readings": 100}
                 for i in range(5)]
        with mock.patch("train_node.list_nodes_with_history", mock.AsyncMock(return_value=nodes)), \
                mock.patch("train_node.run_node_training", mock.AsyncMock(side_effect=_ok_node_training)):
            report = await run_per_node_training(settings=settings)
        self.assertTrue(report.capped)
        self.assertEqual(report.eligible, 5)
        self.assertEqual(report.trained, 2)

    async def test_isolates_per_node_failures(self):
        settings = _settings(node_max_train_per_run=10)
        nodes = [{"node_id": "good", "date_span_days": 90, "total_readings": 100},
                 {"node_id": "bad", "date_span_days": 90, "total_readings": 100}]

        async def _flaky(node_id, *, settings=None, horizon=None, promote=True):
            if node_id == "bad":
                raise RuntimeError("boom")
            return await _ok_node_training(node_id, settings=settings, horizon=horizon, promote=promote)

        with mock.patch("train_node.list_nodes_with_history", mock.AsyncMock(return_value=nodes)), \
                mock.patch("train_node.run_node_training", mock.AsyncMock(side_effect=_flaky)):
            report = await run_per_node_training(settings=settings)
        self.assertEqual(report.trained, 1)
        self.assertEqual(report.failed, 1)

    async def test_db_unreachable_fails_closed(self):
        settings = _settings()
        with mock.patch("train_node.list_nodes_with_history",
                        mock.AsyncMock(side_effect=RuntimeError("db down"))):
            report = await run_per_node_training(settings=settings)
        self.assertEqual(report.eligible, 0)
        self.assertEqual(report.trained, 0)

    async def test_invalid_node_id_rejected(self):
        settings = _settings()
        with mock.patch("train_node.list_nodes_with_history", mock.AsyncMock(return_value=[])):
            report = await run_per_node_training(settings=settings, node_ids=["..", "nodeA"])
        self.assertEqual(report.failed, 1)
        self.assertEqual(report.trained, 0)


class NodeTrainingUnitTests(unittest.IsolatedAsyncioTestCase):
    async def test_skips_node_with_no_data(self):
        from train_node import run_node_training
        settings = _settings(default_horizon=7)
        with mock.patch("train_node.get_historical_data",
                        mock.AsyncMock(return_value=pd.DataFrame())):
            result = await run_node_training("nodeA", settings=settings)
        self.assertEqual(result.status, "skipped")
        self.assertEqual(result.reason, "no_data")

    async def test_invalid_node_id_raises(self):
        from train_node import run_node_training
        settings = _settings()
        with self.assertRaises(ValueError):
            await run_node_training("../etc", settings=settings)


if __name__ == "__main__":
    unittest.main()
