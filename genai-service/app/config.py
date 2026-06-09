import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    app_name: str = "EcoPulse GenAI Service"
    app_version: str = "1.0.0"
    debug: bool = False

    port: int = 8001
    log_level: str = "INFO"

    gemini_api_key: str = ""
    genai_model: str = "gemini-2.0-flash"
    genai_enabled: bool = True
    genai_max_tokens: int = 800

    @property
    def genai_available(self) -> bool:
        return self.genai_enabled and bool(self.gemini_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        debug=os.getenv("DEBUG", "false").lower() in ("1", "true", "yes"),
        port=int(os.getenv("GENAI_PORT", "8001")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        genai_model=os.getenv("GENAI_MODEL", "gemini-2.0-flash"),
        genai_enabled=os.getenv("GENAI_ENABLED", "true").lower()
        in ("1", "true", "yes"),
        genai_max_tokens=int(os.getenv("GENAI_MAX_TOKENS", "800")),
    )
