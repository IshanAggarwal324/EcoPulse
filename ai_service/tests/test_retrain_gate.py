import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jobs import retrain_scheduler as sched  # noqa: E402
from train import TrainingResult  # noqa: E402


def _settings(**kw):
    base = dict(
        registry_dir="registry",
        registry_model_name="lstm_energy_forecast",
        retrain_min_days=30,
        retrain_min_nodes=1,
        retrain_history_days=365,
        retrain_mape_improvement=2.0,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _result(version, gen, cons):
    return TrainingResult(
        version=version,
        promoted=False,
        data_source="live",
        n_rows=400,
        metrics={"n_samples": 5, "mape_generation": gen, "mape_consumption": cons},
    )


class RetrainGateTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, settings, volume, latest, meta, run_result):
        async def _vol(days):  # noqa: ARG001
            return volume
        with mock.patch.object(sched, "get_data_volume_summary", _vol), \
                mock.patch.object(sched, "run_training", mock.AsyncMock(return_value=run_result)), \
                mock.patch.object(sched, "get_latest", mock.Mock(return_value=latest)), \
                mock.patch.object(sched, "read_metadata", mock.Mock(return_value=meta)), \
                mock.patch.object(sched, "set_latest", mock.Mock()) as set_latest:
            report = await sched.run_retrain(settings=settings)
        return report, set_latest

    async def test_data_volume_gate_blocks_training(self):
        settings = _settings()
        vol = {"date_span_days": 10, "distinct_nodes": 1, "total_readings": 50}
        report, set_latest = await self._run(settings, vol, None, {}, None)
        self.assertEqual(report.reason, "data_volume_gate_failed")
        self.assertIsNone(report.trained_version)
        set_latest.assert_not_called()

    async def test_first_model_is_promoted(self):
        settings = _settings()
        vol = {"date_span_days": 60, "distinct_nodes": 3, "total_readings": 1000}
        report, set_latest = await self._run(
            settings, vol, None, {}, _result("v2", 10.0, 10.0)
        )
        self.assertTrue(report.promoted)
        self.assertEqual(report.reason, "promoted")
        self.assertEqual(report.trained_version, "v2")
        set_latest.assert_called_once()

    async def test_improvement_promotes(self):
        settings = _settings(retrain_mape_improvement=2.0)
        vol = {"date_span_days": 60, "distinct_nodes": 3, "total_readings": 1000}
        # current mape = 20, candidate = 15 -> improves by 5 >= 2
        meta = {"metrics": {"mape_generation": 20.0, "mape_consumption": 20.0}}
        report, set_latest = await self._run(
            settings, vol, "v1", meta, _result("v2", 15.0, 15.0)
        )
        self.assertTrue(report.promoted)
        set_latest.assert_called_once()

    async def test_no_improvement_not_promoted(self):
        settings = _settings(retrain_mape_improvement=2.0)
        vol = {"date_span_days": 60, "distinct_nodes": 3, "total_readings": 1000}
        # current mape = 15, candidate = 14 -> improves by 1 < 2 -> not promoted
        meta = {"metrics": {"mape_generation": 15.0, "mape_consumption": 15.0}}
        report, set_latest = await self._run(
            settings, vol, "v1", meta, _result("v2", 14.0, 14.0)
        )
        self.assertFalse(report.promoted)
        self.assertEqual(report.reason, "not_improved")
        set_latest.assert_not_called()

    async def test_force_bypasses_gate_and_promotes(self):
        settings = _settings()
        vol = {"date_span_days": 5, "distinct_nodes": 1, "total_readings": 10}

        async def _vol(days):  # noqa: ARG001
            return vol

        with mock.patch.object(sched, "get_data_volume_summary", _vol), \
                mock.patch.object(sched, "run_training", mock.AsyncMock(return_value=_result("v2", 99.0, 99.0))), \
                mock.patch.object(sched, "get_latest", mock.Mock(return_value="v1")), \
                mock.patch.object(sched, "read_metadata", mock.Mock(return_value={"metrics": {"mape_generation": 5.0, "mape_consumption": 5.0}})), \
                mock.patch.object(sched, "set_latest", mock.Mock()) as set_latest:
            report = await sched.run_retrain(settings=settings, force=True)
        self.assertTrue(report.promoted)
        set_latest.assert_called_once()


class ShouldPromoteTests(unittest.TestCase):
    def test_force_wins(self):
        self.assertTrue(sched._should_promote(candidate_mape=99.0, current_mape=1.0, improvement_margin=2.0, force=True))

    def test_no_candidate_metric(self):
        self.assertFalse(sched._should_promote(candidate_mape=None, current_mape=10.0, improvement_margin=2.0, force=False))

    def test_no_baseline(self):
        self.assertTrue(sched._should_promote(candidate_mape=50.0, current_mape=None, improvement_margin=2.0, force=False))

    def test_marginal_improvement_rejected(self):
        self.assertFalse(sched._should_promote(candidate_mape=9.5, current_mape=10.0, improvement_margin=2.0, force=False))

    def test_clear_improvement_accepted(self):
        self.assertTrue(sched._should_promote(candidate_mape=5.0, current_mape=10.0, improvement_margin=2.0, force=False))


if __name__ == "__main__":
    unittest.main()
