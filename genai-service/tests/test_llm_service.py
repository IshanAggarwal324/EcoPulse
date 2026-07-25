"""Tests for LlmService.complete() Gemini SDK call configuration.

Covers Bug Condition B (Property 3/4): the bounded per-call timeout that must
be passed to generate_content() as `request_options`. No network/real Gemini
API key required — the underlying `genai.GenerativeModel` is swapped for a
stub that just records the kwargs it received.

Run:  python -m unittest tests.test_llm_service   (from genai-service/)
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.services.llm_service import LlmService  # noqa: E402


class _FakeResponse:
    def __init__(self, text="a live answer"):
        self.text = text
        self.usage_metadata = types.SimpleNamespace(total_token_count=10)


class _FakeGenerativeModel:
    """Stands in for genai.GenerativeModel; records generate_content kwargs."""

    def __init__(self):
        self.calls = []

    def generate_content(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        return _FakeResponse()


def _make_llm_service(genai_call_timeout_seconds=8):
    settings = Settings(gemini_api_key="", genai_call_timeout_seconds=genai_call_timeout_seconds) \
        if _settings_supports_timeout() else Settings(gemini_api_key="")
    # gemini_api_key="" means LlmService.__init__ won't try to configure a
    # real client — inject the fake model directly, matching how the router
    # tests stub things without touching the network.
    service = LlmService(settings)
    fake_model = _FakeGenerativeModel()
    service._model = fake_model
    return service, fake_model, settings


def _settings_supports_timeout():
    return "genai_call_timeout_seconds" in Settings.__dataclass_fields__


class GeminiCallTimeoutTests(unittest.TestCase):
    """Property 3: Bug Condition — generate_content() must receive a bounded
    per-call deadline via `request_options`. On UNFIXED code, no such kwarg
    is ever passed.
    """

    def test_complete_passes_request_options_timeout_to_generate_content(self):
        service, fake_model, settings = _make_llm_service(genai_call_timeout_seconds=8)

        service.complete("system prompt", "user prompt")

        self.assertEqual(len(fake_model.calls), 1)
        kwargs = fake_model.calls[0]["kwargs"]
        self.assertIn(
            "request_options",
            kwargs,
            f"generate_content() was called with no request_options timeout kwarg (counterexample: kwargs={kwargs!r})",
        )
        self.assertEqual(kwargs["request_options"], {"timeout": 8})

    def test_complete_uses_custom_configured_timeout(self):
        service, fake_model, settings = _make_llm_service(genai_call_timeout_seconds=15)

        service.complete("system prompt", "user prompt")

        kwargs = fake_model.calls[0]["kwargs"]
        self.assertEqual(kwargs.get("request_options"), {"timeout": 15})


if __name__ == "__main__":
    unittest.main()
