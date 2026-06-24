import os
import sys
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.schemas import ForecastResult  # noqa: E402
from app.services import ab_test_service as ab_module  # noqa: E402
from app.services.ab_test_service import ABTestService  # noqa: E402


def _pred(gen, cons):
    return ForecastResult(
        timestamp=datetime(2024, 1, 1),
        predicted_generation=gen,
        predicted_consumption=cons,
        generation_lower=max(0.0, gen - 1.0),
        generation_upper=gen + 1.0,
        consumption_lower=max(0.0, cons - 1.0),
        consumption_upper=cons + 1.0,
        confidence=0.9,
    )


def _settings(**kw):
    base = dict(
        ab_enabled=True,
        ab_champion_version=None,
        ab_challenger_version="20240102_000000",
        ab_traffic_pct=0.0,
    )
    base.update(kw)
    return SimpleNamespace(**base)


class _FakeCollection:
    def __init__(self):
        self.docs = []

    async def insert_one(self, doc):
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=f"id-{len(self.docs)}")


class EnabledTests(unittest.TestCase):
    def test_disabled_without_challenger(self):
        self.assertFalse(ABTestService(_settings(ab_enabled=False)).enabled)
        self.assertFalse(ABTestService(_settings(ab_challenger_version=None)).enabled)
        self.assertFalse(ABTestService(_settings(ab_traffic_pct=0.0)).enabled)

    def test_enabled_requires_all_three(self):
        self.assertTrue(ABTestService(_settings(ab_traffic_pct=10.0)).enabled)


class AssignmentTests(unittest.TestCase):
    def test_zero_traffic_never_routes(self):
        ab = ABTestService(_settings(ab_traffic_pct=0.0))
        for i in range(200):
            self.assertIsNone(ab.resolve_assignment(f"node-{i}"))

    def test_full_traffic_always_routes(self):
        ab = ABTestService(_settings(ab_traffic_pct=100.0))
        for i in range(200):
            self.assertEqual(ab.resolve_assignment(f"node-{i}"), "20240102_000000")

    def test_assignment_is_deterministic(self):
        ab = ABTestService(_settings(ab_traffic_pct=50.0))
        for i in range(100):
            self.assertEqual(
                ab.resolve_assignment(f"node-{i}"),
                ab.resolve_assignment(f"node-{i}"),
            )

    def test_partial_traffic_within_band(self):
        ab = ABTestService(_settings(ab_traffic_pct=30.0))
        routed = sum(1 for i in range(2000) if ab.resolve_assignment(f"node-{i}"))
        # Expect ~30% (600); allow a generous band for hash variance.
        self.assertTrue(450 <= routed <= 750, f"routed={routed}")


class LogComparisonTests(unittest.IsolatedAsyncioTestCase):
    async def test_log_persists_both_variants(self):
        fake = _FakeCollection()
        with mock.patch.object(ab_module, "modelcomparisons_collection", fake):
            ab = ABTestService(_settings(ab_traffic_pct=100.0))
            champion = [_pred(10.0, 5.0)]
            challenger = [_pred(12.0, 6.0)]
            await ab.log_comparison(
                node_id="node-1",
                champion_version="20240101_000000",
                challenger_version="20240102_000000",
                champion_predictions=champion,
                challenger_predictions=challenger,
            )
        self.assertEqual(len(fake.docs), 1)
        doc = fake.docs[0]
        self.assertEqual(doc["champion_version"], "20240101_000000")
        self.assertEqual(doc["challenger_version"], "20240102_000000")
        self.assertFalse(doc["reconciled"])
        self.assertEqual(len(doc["champion"]), 1)
        self.assertEqual(doc["champion"][0]["predicted_generation"], 10.0)

    async def test_log_swallows_errors(self):
        class Boom:
            async def insert_one(self, doc):
                raise RuntimeError("db down")
        with mock.patch.object(ab_module, "modelcomparisons_collection", Boom()):
            ab = ABTestService(_settings(ab_traffic_pct=100.0))
            # Must not raise.
            await ab.log_comparison(
                node_id="n", champion_version="a", challenger_version="b",
                champion_predictions=[], challenger_predictions=[],
            )


if __name__ == "__main__":
    unittest.main()
