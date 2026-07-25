"""Tests for genai-service /assistant/chat routing latency behavior.

Covers Bug Condition B (Property 3/4): the explanation-only short-circuit
that must skip the Gemini call, and preservation of the live Gemini path for
structured retrieved_data. No httpx/TestClient/network required: the route
handler is invoked directly with a lightweight fake Request, following the
`_FakeRequest` pattern in test_metrics_router.py.

Run:  python -m unittest tests.test_assistant_router   (from genai-service/)
"""
import asyncio
import os
import sys
import time
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings, get_settings  # noqa: E402
from app.routers.assistant import post_assistant_chat  # noqa: E402
from app.schemas.genai import AssistantChatRequest  # noqa: E402
from app.services.llm_service import LlmService  # noqa: E402


class _StubLlmService:
    """Stub LlmService recording whether/how complete() was called."""

    def __init__(self, available=True, reply_text='{"reply": "a live answer"}'):
        self._available = available
        self._reply_text = reply_text
        self.complete_calls = []

    def is_available(self):
        return self._available

    def complete(self, system_prompt, user_prompt):
        self.complete_calls.append((system_prompt, user_prompt))
        result = types.SimpleNamespace(text=self._reply_text)
        return result


def _fake_request(llm_service):
    state = types.SimpleNamespace(llm_service=llm_service)
    app = types.SimpleNamespace(state=state)
    return types.SimpleNamespace(app=app)


def _run(coro):
    return asyncio.run(coro)


class ExplanationOnlyShortCircuitTests(unittest.TestCase):
    """Property 3: Bug Condition — explanation-only retrieved_data must not
    invoke the LLM. On UNFIXED code, post_assistant_chat() has no such
    short-circuit and calls llm.complete() anyway.
    """

    def test_explanation_only_payload_does_not_invoke_llm(self):
        llm = _StubLlmService(available=True)
        request = AssistantChatRequest(
            message="what are carbon credits?",
            retrieved_data={
                "walletConnected": False,
                "explanation": "No wallet connected. Carbon credit data is unavailable.",
            },
        )
        response = _run(post_assistant_chat(request, _fake_request(llm)))

        # EXPECTED (fixed) behavior: complete() is never called, and the
        # fallback/explanation reply is returned immediately.
        self.assertEqual(
            len(llm.complete_calls),
            0,
            "complete() was called for an explanation-only retrieved_data payload "
            f"(counterexample: retrieved_data={{'walletConnected': False, 'explanation': '...'}}, "
            f"complete_calls={llm.complete_calls!r})",
        )
        self.assertIn("No wallet connected", response.reply)


class StructuredDataPreservationTests(unittest.TestCase):
    """Property 4: Preservation — structured (non-trivial) retrieved_data
    must continue to invoke the LLM exactly as before.
    """

    def test_structured_retrieved_data_still_invokes_llm(self):
        llm = _StubLlmService(available=True, reply_text='{"reply": "You consumed 142 kWh"}')
        request = AssistantChatRequest(
            message="how much energy did I use this week?",
            retrieved_data={
                "totalConsumedKwh": 142,
                "priorPeriodConsumedKwh": 98,
                "deltaPercent": 45,
            },
        )
        response = _run(post_assistant_chat(request, _fake_request(llm)))

        self.assertEqual(len(llm.complete_calls), 1)
        self.assertIn("You consumed 142 kWh", response.reply)

    def test_llm_unavailable_still_returns_fallback_without_calling_complete(self):
        llm = _StubLlmService(available=False)
        request = AssistantChatRequest(
            message="show me my carbon credit balance",
            retrieved_data={"totalCreditsTraded": 10, "walletBalance": 5},
        )
        response = _run(post_assistant_chat(request, _fake_request(llm)))

        self.assertEqual(len(llm.complete_calls), 0)
        self.assertTrue(response.reply)


class EndToEndFollowUpTests(unittest.TestCase):
    """Task 8 integration tests: the fixed end-to-end flow spanning both root
    causes. Simulates the follow-up "what are carbon credits?" request that
    would previously have been misclassified into the wallet-gated `carbon`
    intent (now fixed to `faq` by intentClassifier.js) and, even if it still
    carried a wallet-gated explanation-only payload, must return the fallback
    reply via the explanation-only short-circuit without calling
    llm.complete(), completing well within the coordinated timeout budget.
    """

    def test_followup_carbon_question_with_no_wallet_uses_fallback_short_circuit(self):
        llm = _StubLlmService(available=True)
        # retrieved_data as it would look if the backend still attached the
        # wallet-gated carbon retriever's explanation-only payload (Bug
        # Condition A's old misroute); Bug Condition B's fix must still
        # short-circuit this without ever calling the LLM.
        request = AssistantChatRequest(
            message="what are carbon credits?",
            intent="faq",
            retrieved_data={
                "walletConnected": False,
                "explanation": "No wallet connected. Carbon credit data is unavailable.",
            },
        )
        start = time.monotonic()
        response = _run(post_assistant_chat(request, _fake_request(llm)))
        elapsed = time.monotonic() - start

        self.assertEqual(len(llm.complete_calls), 0)
        self.assertIn("No wallet connected", response.reply)
        # Well within the coordinated chat timeout budget (12000ms backend hop).
        self.assertLess(elapsed, 1.0)

    def test_other_llm_consumers_unaffected_by_chat_short_circuit(self):
        """`is_explanation_only()` only guards post_assistant_chat(); other
        LlmService consumers (e.g. /reports/narrate via complete_with_fallback)
        are untouched by this change and keep calling complete() as before,
        regardless of what would otherwise be an explanation-only shape.
        """
        settings = Settings(gemini_api_key="")
        service = LlmService(settings)
        fake_model = types.SimpleNamespace(
            calls=[],
            generate_content=lambda *a, **kw: _record_and_respond(fake_model, a, kw),
        )
        service._model = fake_model

        service.complete("system prompt", "user prompt")

        self.assertEqual(len(fake_model.calls), 1)


def _record_and_respond(fake_model, args, kwargs):
    fake_model.calls.append({"args": args, "kwargs": kwargs})
    return types.SimpleNamespace(text="a live answer", usage_metadata=types.SimpleNamespace(total_token_count=5))


if __name__ == "__main__":
    unittest.main()
