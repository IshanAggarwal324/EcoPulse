"""Tests for LlmService Gemini SDK call configuration.

Covers Bug Condition B (Property 3/4): the bounded per-call timeout that must
be passed on every generate_content() call. No network/real Gemini API key
required — the underlying google-genai client is swapped for a stub that just
records the kwargs it received.

Run:  python -m unittest tests.test_llm_service   (from genai-service/)
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.services.llm_service import (  # noqa: E402
    LlmService,
    REASON_AUTH_FAILED,
    REASON_ERROR,
    REASON_MODEL_NOT_FOUND,
    REASON_NOT_CONFIGURED,
    REASON_OK,
    REASON_RATE_LIMITED,
    REASON_TIMEOUT,
    REASON_UPSTREAM_UNAVAILABLE,
    classify_gemini_error,
)


class _FakeResponse:
    def __init__(self, text="a live answer"):
        self.text = text
        self.usage_metadata = types.SimpleNamespace(total_token_count=10)


class _FakeModels:
    """Stands in for client.models; records generate_content kwargs."""

    def __init__(self, response=None, error=None):
        self.calls = []
        self._response = response if response is not None else _FakeResponse()
        self._error = error

    def generate_content(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        if self._error is not None:
            raise self._error
        return self._response


class _FakeClient:
    def __init__(self, **kwargs):
        self.models = _FakeModels(**kwargs)


def _make_llm_service(genai_call_timeout_seconds=8, **client_kwargs):
    settings = Settings(
        gemini_api_key="",
        genai_call_timeout_seconds=genai_call_timeout_seconds,
    )
    # gemini_api_key="" means LlmService.__init__ won't try to configure a
    # real client — inject the fake client directly, matching how the router
    # tests stub things without touching the network.
    service = LlmService(settings)
    fake_client = _FakeClient(**client_kwargs)
    service._client = fake_client
    return service, fake_client.models, settings


class GeminiCallTimeoutTests(unittest.TestCase):
    """Property 3: generate_content() must receive a bounded per-call
    deadline, expressed in milliseconds via the request config.
    """

    def test_complete_passes_timeout_to_generate_content(self):
        service, models, _ = _make_llm_service(genai_call_timeout_seconds=8)

        service.complete("system prompt", "user prompt")

        self.assertEqual(len(models.calls), 1)
        config = models.calls[0]["kwargs"]["config"]
        self.assertIsNotNone(
            config.http_options,
            "generate_content() was called with no http_options timeout",
        )
        self.assertEqual(config.http_options.timeout, 8000)
        # The API rejects deadlines under 10s, so the server deadline header
        # must be raised even though the client-side timeout stays at 8s.
        self.assertEqual(config.http_options.headers["X-Server-Timeout"], "10")

    def test_server_deadline_header_follows_longer_timeouts(self):
        service, models, _ = _make_llm_service(genai_call_timeout_seconds=15)

        service.complete("system prompt", "user prompt")

        config = models.calls[0]["kwargs"]["config"]
        self.assertEqual(config.http_options.headers["X-Server-Timeout"], "15")

    def test_complete_uses_custom_configured_timeout(self):
        service, models, _ = _make_llm_service(genai_call_timeout_seconds=15)

        service.complete("system prompt", "user prompt")

        config = models.calls[0]["kwargs"]["config"]
        self.assertEqual(config.http_options.timeout, 15000)

    def test_complete_targets_configured_model_and_token_limit(self):
        service, models, settings = _make_llm_service()

        service.complete("system prompt", "user prompt")

        kwargs = models.calls[0]["kwargs"]
        self.assertEqual(kwargs["model"], settings.genai_model)
        self.assertEqual(kwargs["config"].max_output_tokens, settings.genai_max_tokens)

    def test_default_models_are_not_the_retired_ones(self):
        settings = Settings()
        self.assertNotEqual(settings.genai_model, "gemini-2.0-flash")
        self.assertNotEqual(settings.embedding_model, "text-embedding-004")

    def test_thinking_level_is_sent_when_configured(self):
        service, models, _ = _make_llm_service()

        service.complete("system prompt", "user prompt")

        config = models.calls[0]["kwargs"]["config"]
        self.assertIsNotNone(config.thinking_config)

    def test_thinking_config_omitted_when_level_blank(self):
        settings = Settings(gemini_api_key="", genai_thinking_level="")
        service = LlmService(settings)
        client = _FakeClient()
        service._client = client

        service.complete("system prompt", "user prompt")

        self.assertIsNone(client.models.calls[0]["kwargs"]["config"].thinking_config)

    def test_empty_response_raises_so_callers_fall_back(self):
        service, _, _ = _make_llm_service(response=_FakeResponse(text=None))

        with self.assertRaises(RuntimeError):
            service.complete("system prompt", "user prompt")


class ProbeTests(unittest.TestCase):
    def test_probe_success(self):
        service, models, _ = _make_llm_service()

        ok, reason = service.probe(timeout_seconds=4)

        self.assertTrue(ok)
        self.assertEqual(reason, REASON_OK)
        config = models.calls[0]["kwargs"]["config"]
        self.assertEqual(config.http_options.timeout, 4000)
        self.assertLessEqual(config.max_output_tokens, 16)

    def test_probe_not_configured_makes_no_call(self):
        service = LlmService(Settings(gemini_api_key=""))

        self.assertEqual(service.probe(), (False, REASON_NOT_CONFIGURED))

    def test_probe_failure_returns_coarse_reason_not_raw_message(self):
        err = Exception("secret-ish detail: key=AIzaFAKE")
        err.code = 404
        service, _, _ = _make_llm_service(error=err)

        ok, reason = service.probe()

        self.assertFalse(ok)
        self.assertEqual(reason, REASON_MODEL_NOT_FOUND)
        self.assertNotIn("AIza", reason)


class ClassifyErrorTests(unittest.TestCase):
    def _err(self, code, message="boom"):
        err = Exception(message)
        err.code = code
        return err

    def test_status_code_mapping(self):
        self.assertEqual(classify_gemini_error(self._err(404)), REASON_MODEL_NOT_FOUND)
        self.assertEqual(classify_gemini_error(self._err(401)), REASON_AUTH_FAILED)
        self.assertEqual(classify_gemini_error(self._err(403)), REASON_AUTH_FAILED)
        self.assertEqual(
            classify_gemini_error(self._err(400, "API key not valid")), REASON_AUTH_FAILED
        )
        self.assertEqual(classify_gemini_error(self._err(429)), REASON_RATE_LIMITED)
        self.assertEqual(classify_gemini_error(self._err(504)), REASON_TIMEOUT)
        self.assertEqual(
            classify_gemini_error(self._err(503)), REASON_UPSTREAM_UNAVAILABLE
        )

    def test_transport_errors(self):
        class ReadTimeout(Exception):
            pass

        class ConnectError(Exception):
            pass

        self.assertEqual(classify_gemini_error(ReadTimeout()), REASON_TIMEOUT)
        self.assertEqual(
            classify_gemini_error(ConnectError()), REASON_UPSTREAM_UNAVAILABLE
        )
        self.assertEqual(classify_gemini_error(ValueError("x")), REASON_ERROR)


if __name__ == "__main__":
    unittest.main()
