import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services import drift_monitor as dm  # noqa: E402
from app.services.drift_monitor import DriftMonitor  # noqa: E402


def _settings(**kw):
    base = dict(
        registry_dir="registry",
        registry_model_name="lstm_energy_forecast",
        drift_window_days=14,
        drift_mape_threshold=0.5,
    )
    base.update(kw)
    return SimpleNamespace(**base)


class _AsyncIter:
    def __init__(self, items):
        self._items = list(items)
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item


class _FakeCollection:
    """Supports find() returning an async iterator (check_drift path)."""
    def __init__(self, docs):
        self._docs = docs

    def find(self, *args, **kwargs):  # noqa: ARG002
        return _AsyncIter(self._docs)


class CheckDriftTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, docs, latest, meta):
        coll = _FakeCollection(docs)
        with mock.patch.object(dm, "modelcomparisons_collection", coll), \
                mock.patch.object(dm, "get_latest", mock.Mock(return_value=latest)), \
                mock.patch.object(dm, "read_metadata", mock.Mock(return_value=meta)):
            return await DriftMonitor(_settings()).check_drift()

    async def test_warning_when_errors_balloon(self):
        docs = [{"champion_mape": 25.0} for _ in range(6)]
        meta = {"metrics": {"mape_generation": 10.0, "mape_consumption": 10.0}}
        report = await self._run(docs, "v1", meta)
        self.assertEqual(report.status, "warning")
        self.assertAlmostEqual(report.baseline_mape, 10.0)
        self.assertGreater(report.relative_increase, 0.5)
        self.assertEqual(report.samples, 6)

    async def test_ok_when_stable(self):
        docs = [{"champion_mape": 11.0} for _ in range(6)]
        meta = {"metrics": {"mape_generation": 10.0, "mape_consumption": 10.0}}
        report = await self._run(docs, "v1", meta)
        self.assertEqual(report.status, "ok")
        self.assertLess(report.relative_increase, 0.5)

    async def test_unknown_when_too_few_samples(self):
        docs = [{"champion_mape": 99.0} for _ in range(2)]
        meta = {"metrics": {"mape_generation": 10.0, "mape_consumption": 10.0}}
        report = await self._run(docs, "v1", meta)
        self.assertEqual(report.status, "unknown")


class _FluentFind:
    """Supports the reconcile chain: find().sort().limit().to_list()."""
    def __init__(self, docs):
        self._docs = docs

    def find(self, *args, **kwargs):  # noqa: ARG002
        return self

    def sort(self, *args, **kwargs):  # noqa: ARG002
        return self

    def limit(self, n):  # noqa: ARG002
        return self

    async def to_list(self, length=None):  # noqa: ARG002
        return self._docs


class _ReconcileCollection(_FluentFind):
    def __init__(self, docs):
        super().__init__(docs)
        self.updates = []

    async def update_one(self, query, update):  # noqa: ARG002
        self.updates.append((query, update))


class ReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconcile_fills_actuals_and_mape(self):
        idx = pd.date_range("2024-01-01", periods=3, freq="D")
        df = pd.DataFrame({"generation": [100.0, 100.0, 100.0], "consumption": [50.0, 50.0, 50.0]}, index=idx)

        docs = [
            {
                "_id": "doc1",
                "node_id": "n1",
                "created_at": pd.Timestamp("2024-01-05"),
                "champion": [
                    {"timestamp": "2024-01-01T00:00:00", "predicted_generation": 110.0, "predicted_consumption": 55.0},
                    {"timestamp": "2024-01-02T00:00:00", "predicted_generation": 110.0, "predicted_consumption": 55.0},
                ],
                "challenger": [
                    {"timestamp": "2024-01-01T00:00:00", "predicted_generation": 100.0, "predicted_consumption": 50.0},
                ],
            }
        ]
        coll = _ReconcileCollection(docs)
        with mock.patch.object(dm, "modelcomparisons_collection", coll), \
                mock.patch.object(dm, "get_historical_data", mock.AsyncMock(return_value=df)):
            count = await DriftMonitor(_settings()).reconcile_actuals(max_docs=10)
        self.assertEqual(count, 1)
        self.assertEqual(len(coll.updates), 1)
        _q, update = coll.updates[0]
        self.assertTrue(update["$set"]["reconciled"])
        self.assertIsNotNone(update["$set"]["champion_mape"])
        self.assertIsNotNone(update["$set"]["challenger_mape"])

    async def test_reconcile_skips_when_no_actuals(self):
        empty = pd.DataFrame(columns=["generation", "consumption"])
        docs = [{"_id": "d", "node_id": "n", "created_at": pd.Timestamp("2024-01-05"),
                 "champion": [], "challenger": []}]
        coll = _ReconcileCollection(docs)
        with mock.patch.object(dm, "modelcomparisons_collection", coll), \
                mock.patch.object(dm, "get_historical_data", mock.AsyncMock(return_value=empty)):
            count = await DriftMonitor(_settings()).reconcile_actuals(max_docs=10)
        self.assertEqual(count, 0)
        self.assertEqual(len(coll.updates), 0)


if __name__ == "__main__":
    unittest.main()
