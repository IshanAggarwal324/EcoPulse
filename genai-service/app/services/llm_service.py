import json
import logging
import re
from typing import Any, Optional

import google.generativeai as genai
from pydantic import BaseModel, ValidationError

from app.config import Settings

logger = logging.getLogger(__name__)


class LlmCompletionResult(BaseModel):
    text: str
    model: str
    tokens_used: Optional[int] = None


class LlmService:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._model_name = settings.genai_model
        self._max_tokens = settings.genai_max_tokens
        self._model = None

        if settings.gemini_api_key:
            try:
                genai.configure(api_key=settings.gemini_api_key)
                self._model = genai.GenerativeModel(self._model_name)
                logger.info(
                    "Gemini client configured: model=%s", self._model_name
                )
            except Exception:
                logger.exception("Failed to configure Gemini client")
                self._model = None
        else:
            logger.warning("GEMINI_API_KEY not set — running in fallback mode")

    def is_available(self) -> bool:
        return self._model is not None and self._settings.genai_enabled

    def complete(
        self, system_prompt: str, user_prompt: str
    ) -> LlmCompletionResult:
        if not self.is_available():
            raise RuntimeError("Gemini client not available")

        full_prompt = f"{system_prompt}\n\n{user_prompt}"
        response = self._model.generate_content(
            full_prompt,
            generation_config=genai.types.GenerationConfig(
                max_output_tokens=self._max_tokens,
            ),
        )

        text = response.text
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

        response = self._model.generate_content(
            full_prompt,
            generation_config=genai.types.GenerationConfig(
                max_output_tokens=self._max_tokens,
                response_mime_type="application/json",
            ),
        )

        raw = response.text.strip()
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
