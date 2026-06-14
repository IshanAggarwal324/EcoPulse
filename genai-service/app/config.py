import os
from dataclasses import dataclass
from functools import lru_cache


def _parse_origins(value: str) -> list[str]:
    return [origin.strip() for origin in value.split(",") if origin.strip()]


@dataclass(frozen=True)
class Settings:
    app_name: str = "EcoPulse GenAI Service"
    app_version: str = "1.0.0"
    debug: bool = False

    port: int = 8001
    host: str = "127.0.0.1"
    log_level: str = "INFO"
    cors_origins: tuple[str, ...] = ()
    internal_api_key: str = ""

    gemini_api_key: str = ""
    genai_model: str = "gemini-2.0-flash"
    genai_enabled: bool = True
    genai_max_tokens: int = 800
    genai_max_input_chars: int = 12000

    embedding_model: str = "text-embedding-004"
    docs_dir: str = ""
    embedding_cache_path: str = ""

    @property
    def genai_available(self) -> bool:
        return self.genai_enabled and bool(self.gemini_api_key)

    @property
    def embedding_available(self) -> bool:
        return bool(self.gemini_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        debug=os.getenv("DEBUG", "false").lower() in ("1", "true", "yes"),
        port=int(os.getenv("GENAI_PORT", "8001")),
        host=os.getenv("GENAI_HOST", "127.0.0.1"),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        cors_origins=tuple(_parse_origins(os.getenv("GENAI_CORS_ORIGINS", ""))),
        internal_api_key=os.getenv("INTERNAL_SERVICE_API_KEY", ""),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        genai_model=os.getenv("GENAI_MODEL", "gemini-2.0-flash"),
        genai_enabled=os.getenv("GENAI_ENABLED", "true").lower()
        in ("1", "true", "yes"),
        genai_max_tokens=int(os.getenv("GENAI_MAX_TOKENS", "800")),
        genai_max_input_chars=int(os.getenv("GENAI_MAX_INPUT_CHARS", "12000")),
        embedding_model=os.getenv("EMBEDDING_MODEL", "text-embedding-004"),
        docs_dir=os.getenv("DOCS_DIR", ""),
        embedding_cache_path=os.getenv("EMBEDDING_CACHE_PATH", ""),
    )
