"""Tests for the live, cached Gemini health probe and the /health route.

No network or real API key: the LlmService probe is stubbed.

Run:  python -m unittest tests.test_gemini_health   (from genai-service/)
"""
import asyncio
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.routers import health as health_router  # noqa: E402
from app.services.gemini_health import GeminiHealthProbe  # noqa: E402


class _StubLlm:
    def __init__(self, results):
        self._results = list(results)
        self.calls = 0

    def probe(self, timeout_seconds=4):
        self.calls += 1
        return self._results[min(self.calls - 1, len(self._results) - 1)]


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class GeminiHealthProbeTests(unittest.TestCase):
    def test_result_is_cached_within_ttl(self):
        clock = _Clock()
        llm = _StubLlm([(True, "ok")])
        probe = GeminiHealthProbe(llm, ttl_seconds=60, clock=clock)

        first = probe.check()
        clock.now += 59
        second = probe.check()

        self.assertTrue(first.ok)
        self.assertEqual(llm.calls, 1)
        self.assertIs(first, second)

    def test_probe_runs_again_after_ttl(self):
        clock = _Clock()
        llm = _StubLlm([(True, "ok")])
        probe = GeminiHealthProbe(llm, ttl_seconds=60, clock=clock)

        probe.check()
        clock.now += 61
        probe.check()

        self.assertEqual(llm.calls, 2)

    def test_failures_are_rechecked_sooner_than_successes(self):
        clock = _Clock()
        llm = _StubLlm([(False, "model_not_found"), (True, "ok")])
        probe = GeminiHealthProbe(llm, ttl_seconds=60, clock=clock)

        failed = probe.check()
        clock.now += 16  # past the 15s failure TTL, well inside the 60s TTL
        recovered = probe.check()

        self.assertFalse(failed.ok)
        self.assertEqual(failed.reason, "model_not_found")
        self.assertTrue(recovered.ok)
        self.assertEqual(llm.calls, 2)


def _request(probe=None):
    state = types.SimpleNamespace(
        gemini_probe=probe,
        doc_rag_service=types.SimpleNamespace(docs_loaded_count=3),
    )
    return types.SimpleNamespace(app=types.SimpleNamespace(state=state))


def _run_health(settings, probe):
    with mock.patch.object(health_router, "get_settings", return_value=settings):
        return asyncio.run(health_router.health(_request(probe)))


class HealthRouteTests(unittest.TestCase):
    def test_healthy_when_probe_succeeds(self):
        probe = GeminiHealthProbe(_StubLlm([(True, "ok")]))

        body = _run_health(Settings(gemini_api_key="k"), probe)

        self.assertEqual(body["status"], "healthy")
        self.assertTrue(body["available"])
        self.assertFalse(body["fallbackMode"])
        self.assertEqual(body["docs_loaded_count"], 3)
        self.assertEqual(body["checks"][0]["details"]["reason"], "ok")

    def test_degraded_when_model_is_gone_even_with_key_configured(self):
        """The regression this guards: a retired model used to read healthy
        because /health only checked that an API key was set."""
        probe = GeminiHealthProbe(_StubLlm([(False, "model_not_found")]))

        body = _run_health(Settings(gemini_api_key="k"), probe)

        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["available"])
        self.assertTrue(body["fallbackMode"])
        self.assertEqual(body["checks"][0]["details"]["reason"], "model_not_found")

    def test_not_configured_skips_probe(self):
        llm = _StubLlm([(True, "ok")])
        probe = GeminiHealthProbe(llm)

        body = _run_health(Settings(gemini_api_key=""), probe)

        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["available"])
        self.assertEqual(body["checks"][0]["details"]["reason"], "not_configured")
        self.assertEqual(llm.calls, 0)

    def test_probe_disabled_falls_back_to_config_check(self):
        body = _run_health(Settings(gemini_api_key="k"), None)

        self.assertEqual(body["status"], "healthy")
        self.assertTrue(body["available"])
        self.assertNotIn("reason", body["checks"][0]["details"])

    def test_response_never_contains_the_api_key(self):
        probe = GeminiHealthProbe(_StubLlm([(False, "auth_failed")]))

        body = _run_health(Settings(gemini_api_key="SUPER-SECRET-KEY"), probe)

        self.assertNotIn("SUPER-SECRET-KEY", repr(body))


if __name__ == "__main__":
    unittest.main()
