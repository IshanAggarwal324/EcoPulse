"""Tests for the shared health contract builder (Module 7.1).

Pure-function tests of app.health_contract — no FastAPI app, httpx, or model
load required, so they run anywhere the stdlib does.
"""
import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.health_contract import (  # noqa: E402
    DEGRADED,
    HEALTHY,
    SCHEMA_VERSION,
    UNHEALTHY,
    build_contract,
    normalize_status,
    uptime_seconds,
)

SERVICE_NAME = "ecopulse-ai-service"
VALID_STATUSES = {HEALTHY, DEGRADED, UNHEALTHY}


def _assert_iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) is not None


class NormalizeStatusTests(unittest.TestCase):
    def test_healthy_aliases(self):
        for value in ("ok", "up", "ready", "available", "true", HEALTHY, "Healthy"):
            self.assertEqual(normalize_status(value), HEALTHY)

    def test_degraded_aliases(self):
        for value in ("partial", "fallback", DEGRADED):
            self.assertEqual(normalize_status(value), DEGRADED)

    def test_unhealthy_and_unknown_fail_closed(self):
        for value in ("", None, "down", "error", False, "bogus"):
            self.assertEqual(normalize_status(value), UNHEALTHY)


class BuildContractTests(unittest.TestCase):
    def test_minimal_contract_is_schema_conformant(self):
        contract = build_contract(SERVICE_NAME, HEALTHY, [])
        self.assertEqual(contract["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(contract["service"], SERVICE_NAME)
        self.assertIn(contract["status"], VALID_STATUSES)
        self.assertTrue(_assert_iso(contract["checkedAt"]))
        self.assertGreaterEqual(contract["uptimeSeconds"], 0)
        self.assertEqual(contract["checks"], [])

    def test_overall_is_worst_of_service_and_checks(self):
        # A failing dependency must never read as healthy.
        contract = build_contract(
            SERVICE_NAME,
            HEALTHY,
            [{"id": "model", "status": "unhealthy", "latencyMs": 0}],
        )
        self.assertEqual(contract["status"], UNHEALTHY)
        self.assertEqual(contract["checks"][0]["status"], UNHEALTHY)

    def test_degraded_check_lowers_overall(self):
        contract = build_contract(
            SERVICE_NAME,
            HEALTHY,
            [{"id": "model", "status": "degraded"}],
        )
        self.assertEqual(contract["status"], DEGRADED)

    def test_check_status_is_normalized(self):
        contract = build_contract(
            SERVICE_NAME,
            HEALTHY,
            [{"id": "model", "status": "available"}],
        )
        self.assertEqual(contract["checks"][0]["status"], HEALTHY)

    def test_check_without_id_gets_default(self):
        contract = build_contract(SERVICE_NAME, HEALTHY, [{"status": "ok"}])
        self.assertEqual(contract["checks"][0]["id"], "unknown")

    def test_uptime_is_monotonic_non_negative(self):
        first = uptime_seconds()
        second = uptime_seconds()
        self.assertGreaterEqual(first, 0)
        self.assertGreaterEqual(second, first)


if __name__ == "__main__":
    unittest.main()
