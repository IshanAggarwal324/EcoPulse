import json
import logging
import math
import re
from typing import Any, Optional

from google import genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.services.fallback_templates import render_chat_reply, render_report_summary

logger = logging.getLogger(__name__)

# The Gemini API rejects request deadlines shorter than this (HTTP 400).
_MIN_SERVER_DEADLINE_SECONDS = 10

# Coarse, non-sensitive failure reasons. These are surfaced on the
# unauthenticated /health route, so they must never carry raw SDK messages
# (which can echo request details).
REASON_OK = "ok"
REASON_NOT_CONFIGURED = "not_configured"
REASON_MODEL_NOT_FOUND = "model_not_found"
REASON_AUTH_FAILED = "auth_failed"
REASON_RATE_LIMITED = "rate_limited"
REASON_TIMEOUT = "timeout"
REASON_UPSTREAM_UNAVAILABLE = "upstream_unavailable"
REASON_ERROR = "error"


def classify_gemini_error(exc: BaseException) -> str:
    """Map an SDK/transport exception to a coarse reason code."""
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        if code == 404:
            return REASON_MODEL_NOT_FOUND
        if code in (401, 403):
            return REASON_AUTH_FAILED
        if code == 400 and "api key" in str(exc).lower():
            return REASON_AUTH_FAILED
        if code == 429:
            return REASON_RATE_LIMITED
        if code in (408, 504):
            return REASON_TIMEOUT
        if code >= 500:
            return REASON_UPSTREAM_UNAVAILABLE

    name = type(exc).__name__.lower()
    if "timeout" in name or isinstance(exc, TimeoutError):
        return REASON_TIMEOUT
    if "connect" in name or "network" in name:
        return REASON_UPSTREAM_UNAVAILABLE
    return REASON_ERROR


class LlmCompletionResult(BaseModel):
    text: str
    model: str
    tokens_used: Optional[int] = None


class LlmService:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._model_name = settings.genai_model
        self._max_tokens = settings.genai_max_tokens
        self._max_input_chars = settings.genai_max_input_chars
        self._client = None

        if settings.gemini_api_key:
            try:
                self._client = genai.Client(api_key=settings.gemini_api_key)
                logger.info(
                    "Gemini client configured: model=%s", self._model_name
                )
            except Exception:
                logger.exception("Failed to configure Gemini client")
                self._client = None
        else:
            logger.warning("GEMINI_API_KEY not set — running in fallback mode")

    def is_available(self) -> bool:
        return self._client is not None and self._settings.genai_enabled

    def _build_config(
        self,
        *,
        timeout_seconds: float | None = None,
        max_output_tokens: int | None = None,
        json_mode: bool = False,
    ) -> types.GenerateContentConfig:
        kwargs: dict[str, Any] = {
            "max_output_tokens": max_output_tokens or self._max_tokens,
        }
        thinking_level = self._settings.genai_thinking_level
        if thinking_level:
            kwargs["thinking_config"] = types.ThinkingConfig(
                thinking_level=thinking_level
            )
        if timeout_seconds:
            kwargs["http_options"] = self._http_options(timeout_seconds)
        if json_mode:
            kwargs["response_mime_type"] = "application/json"
        return types.GenerateContentConfig(**kwargs)

    @staticmethod
    def _http_options(timeout_seconds: float) -> types.HttpOptions:
        """Per-request timeout that the Gemini API will actually accept.

        ``HttpOptions.timeout`` (milliseconds) bounds the client side, but the
        SDK also forwards it as the ``X-Server-Timeout`` deadline header, and the
        API rejects any deadline under 10s with a 400 ("deadline 8s is too
        short"). Setting the header ourselves keeps the short client-side
        timeout (which the backend's latency budget relies on) while sending a
        server deadline the API accepts.
        """
        return types.HttpOptions(
            timeout=int(timeout_seconds * 1000),
            headers={
                "X-Server-Timeout": str(
                    max(_MIN_SERVER_DEADLINE_SECONDS, math.ceil(timeout_seconds))
                )
            },
        )

    def complete(
        self, system_prompt: str, user_prompt: str
    ) -> LlmCompletionResult:
        if not self.is_available():
            raise RuntimeError("Gemini client not available")

        full_prompt = f"{system_prompt}\n\n{user_prompt}"
        if len(full_prompt) > self._max_input_chars:
            logger.warning(
                "Prompt truncated from %d to %d chars",
                len(full_prompt),
                self._max_input_chars,
            )
            full_prompt = full_prompt[: self._max_input_chars]
        response = self._client.models.generate_content(
            model=self._model_name,
            contents=full_prompt,
            config=self._build_config(
                timeout_seconds=self._settings.genai_call_timeout_seconds
            ),
        )

        text = response.text
        if not text:
            # Blocked or empty candidates yield text=None; surface it so the
            # caller falls back to a template instead of crashing on len(None).
            raise RuntimeError("Gemini returned an empty response")
        tokens_used = None
        try:
            tokens_used = response.usage_metadata.total_token_count
        except (AttributeError, TypeError):
            pass

        logger.info(
            "Gemini completion: model=%s tokens=%s len=%d",
            self._model_name,
            tokens_used,
            len(text),
        )

        return LlmCompletionResult(
            text=text,
            model=self._model_name,
            tokens_used=tokens_used,
        )

    def probe(self, timeout_seconds: float = 4) -> tuple[bool, str]:
        """Make one minimal real Gemini call to verify the model is reachable.

        Returns ``(ok, reason)`` where ``reason`` is a coarse code (never a raw
        error message). Intended for health checks; callers should cache the
        result (see ``GeminiHealthProbe``).
        """
        if not self.is_available():
            return False, REASON_NOT_CONFIGURED
        try:
            self._client.models.generate_content(
                model=self._model_name,
                contents="ping",
                config=self._build_config(
                    timeout_seconds=timeout_seconds, max_output_tokens=16
                ),
            )
            return True, REASON_OK
        except Exception as exc:
            reason = classify_gemini_error(exc)
            logger.warning(
                "Gemini health probe failed: model=%s reason=%s error=%s",
                self._model_name,
                reason,
                type(exc).__name__,
            )
            return False, reason

    def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: type[BaseModel],
    ) -> BaseModel:
        if not self.is_available():
            raise RuntimeError("Gemini client not available")

        json_instruction = (
            "You MUST respond with valid JSON only. "
            "No markdown fences, no commentary — raw JSON object."
        )
        full_prompt = f"{system_prompt}\n\n{json_instruction}\n\n{user_prompt}"
        if len(full_prompt) > self._max_input_chars:
            logger.warning(
                "JSON prompt truncated from %d to %d chars",
                len(full_prompt),
                self._max_input_chars,
            )
            full_prompt = full_prompt[: self._max_input_chars]

        response = self._client.models.generate_content(
            model=self._model_name,
            contents=full_prompt,
            config=self._build_config(json_mode=True),
        )

        raw = (response.text or "").strip()
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            logger.error("Gemini returned invalid JSON: %s", exc)
            raise ValueError(f"Gemini returned invalid JSON: {exc}") from exc

        try:
            return schema.model_validate(parsed)
        except ValidationError as exc:
            logger.error("Gemini JSON failed schema validation: %s", exc)
            raise ValueError(
                f"Gemini response failed schema validation: {exc}"
            ) from exc

    def complete_with_fallback(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        mode: str = "chat",
        metrics: dict[str, Any] | None = None,
        retrieved_data: dict[str, Any] | None = None,
    ) -> LlmCompletionResult:
        try:
            return self.complete(system_prompt, user_prompt)
        except Exception:
            logger.warning(
                "Gemini call failed — using fallback template (mode=%s)", mode
            )

        if mode == "report" and metrics is not None:
            fallback_text = render_report_summary(metrics)
        else:
            fallback_text = render_chat_reply(user_prompt, retrieved_data)

        return LlmCompletionResult(
            text=fallback_text,
            model="fallback-template",
            tokens_used=0,
        )
