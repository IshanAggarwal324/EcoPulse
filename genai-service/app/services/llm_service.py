import logging

import google.generativeai as genai

from app.config import Settings

logger = logging.getLogger(__name__)


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
