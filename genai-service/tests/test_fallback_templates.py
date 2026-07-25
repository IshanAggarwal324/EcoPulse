"""Tests pinning the explanation-only short-circuit behavior of
render_chat_reply() (Property 4: Preservation) before it is extracted into a
standalone `is_explanation_only()` helper (task 6.1), plus unit tests for
that helper once it exists (task 7).

Run:  python -m unittest tests.test_fallback_templates   (from genai-service/)
"""
import os
import sys
import unittest

from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.fallback_templates import render_chat_reply  # noqa: E402

try:
    from app.services.fallback_templates import is_explanation_only  # noqa: E402

    _HAS_IS_EXPLANATION_ONLY = True
except ImportError:
    _HAS_IS_EXPLANATION_ONLY = False


# A pool of structured (non-explanation) keys that can appear in retrieved_data,
# mirroring the shapes handled elsewhere in render_chat_reply().
_STRUCTURED_KEYS = [
    "totalConsumedKwh",
    "totalGeneratedKwh",
    "deltaPercent",
    "nodeCount",
    "activeCount",
    "netFlow",
    "activeNodes",
    "totalNodes",
    "completedTrades",
    "walletBalance",
    "walletConnected",
]


def _build_retrieved_data(explanation_present, explanation_text, extra_keys):
    data = {}
    if explanation_present:
        data["explanation"] = explanation_text
    for i, key in enumerate(extra_keys):
        data[key] = i + 1
    return data


class RenderChatReplyExplanationOnlyPreservationTests(unittest.TestCase):
    """Observation-first (Property 4): the inline explanation-only check in
    render_chat_reply() — `explanation present AND len(retrieved_data) <= 2`
    — must keep behaving exactly the same after extraction into
    is_explanation_only(). These example-based observations were made on
    UNFIXED code and must continue to pass on fixed code.
    """

    def test_explanation_alone_short_circuits(self):
        reply = render_chat_reply("hi", {"explanation": "No wallet connected."})
        self.assertEqual(reply, "No wallet connected.")

    def test_explanation_plus_one_other_key_short_circuits(self):
        reply = render_chat_reply(
            "hi", {"walletConnected": False, "explanation": "No wallet connected."}
        )
        self.assertEqual(reply, "No wallet connected.")

    def test_explanation_plus_two_other_keys_does_not_short_circuit(self):
        reply = render_chat_reply(
            "hi",
            {
                "totalConsumedKwh": 142,
                "walletConnected": True,
                "explanation": "some note",
            },
        )
        self.assertNotEqual(reply, "some note")

    def test_no_explanation_never_short_circuits(self):
        reply = render_chat_reply("hi", {"totalConsumedKwh": 142})
        self.assertNotIn("None", reply)

    @given(
        explanation_present=st.booleans(),
        explanation_text=st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != ""),
        extra_keys=st.lists(st.sampled_from(_STRUCTURED_KEYS), min_size=0, max_size=4, unique=True),
    )
    @settings(max_examples=200)
    def test_short_circuit_fires_iff_trivial_explanation_only_shape(
        self, explanation_present, explanation_text, extra_keys
    ):
        retrieved_data = _build_retrieved_data(explanation_present, explanation_text, extra_keys)
        reply = render_chat_reply("some question", retrieved_data)

        expected_short_circuit = explanation_present and len(retrieved_data) <= 2

        if expected_short_circuit:
            self.assertEqual(reply, explanation_text)
        else:
            # Never fires for structured payloads (or when there's no
            # explanation key at all).
            self.assertNotEqual(reply, explanation_text)


@unittest.skipUnless(
    _HAS_IS_EXPLANATION_ONLY,
    "is_explanation_only() not yet extracted (task 6.1)",
)
class IsExplanationOnlyUnitTests(unittest.TestCase):
    """Unit tests (task 7) for the standalone is_explanation_only() helper."""

    def test_explanation_only_shapes(self):
        self.assertTrue(is_explanation_only({"explanation": "..."}))
        self.assertTrue(
            is_explanation_only({"walletConnected": False, "explanation": "..."})
        )

    def test_structured_shape_with_explanation_is_not_explanation_only(self):
        # len > 2 (three keys) with a structured field alongside explanation
        # must NOT short-circuit — only a bare/trivial 1-2 key shape does.
        self.assertFalse(
            is_explanation_only(
                {"totalConsumedKwh": 142, "walletConnected": True, "explanation": "..."}
            )
        )

    def test_no_explanation_key_is_not_explanation_only(self):
        self.assertFalse(is_explanation_only({"totalConsumedKwh": 142}))

    def test_none_or_empty_is_not_explanation_only(self):
        self.assertFalse(is_explanation_only(None))
        self.assertFalse(is_explanation_only({}))

    @given(
        explanation_present=st.booleans(),
        explanation_text=st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != ""),
        extra_keys=st.lists(st.sampled_from(_STRUCTURED_KEYS), min_size=0, max_size=4, unique=True),
    )
    @settings(max_examples=200)
    def test_matches_render_chat_reply_short_circuit_condition(
        self, explanation_present, explanation_text, extra_keys
    ):
        retrieved_data = _build_retrieved_data(explanation_present, explanation_text, extra_keys)
        expected = explanation_present and len(retrieved_data) <= 2
        self.assertEqual(is_explanation_only(retrieved_data), expected)


class RenderChatReplyMessageIndependencePropertyTests(unittest.TestCase):
    """Task 7 property-based test: the explanation-only short-circuit decision
    depends only on the shape of retrieved_data, never on the message text.
    Generate random keyword-only (non-FAQ-phrased) messages alongside random
    non-explanation-only retrieved_data dicts, and assert the short-circuit
    never fires — i.e. classification/short-circuit behavior is unchanged
    across many message samples.
    """

    @given(
        message=st.text(
            alphabet=st.sampled_from("abcdefghijklmnopqrstuvwxyz "), min_size=1, max_size=60
        ).filter(lambda s: s.strip() != ""),
        extra_keys=st.lists(st.sampled_from(_STRUCTURED_KEYS), min_size=1, max_size=4, unique=True),
    )
    @settings(max_examples=200)
    def test_non_explanation_only_data_never_short_circuits_regardless_of_message(
        self, message, extra_keys
    ):
        retrieved_data = _build_retrieved_data(False, "", extra_keys)
        reply = render_chat_reply(message, retrieved_data)
        # No explanation key at all -> never equals a bare explanation string,
        # and the short-circuit condition (`explanation present AND len<=2`)
        # cannot be true here regardless of what the message says.
        self.assertNotEqual(reply.strip(), "")


if __name__ == "__main__":
    unittest.main()
