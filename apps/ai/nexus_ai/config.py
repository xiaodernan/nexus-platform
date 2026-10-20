"""Environment-backed settings (DECISIONS.md D4/D5: no secrets in code).

Every knob has a safe offline default so `import nexus_ai.config` and the whole
test suite work with no env vars and no network.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AI_ROOT.parent.parent

VALID_PROVIDERS = ("mock", "anthropic", "openai")


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _env_bool(key: str, default: bool = False) -> bool:
    raw = _env(key)
    if not raw:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    """Resolved configuration for one process."""

    llm_provider: str = "mock"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model_cheap: str = ""
    llm_model_mid: str = ""
    llm_model_reason: str = ""
    request_timeout_s: float = 12.0
    tool_timeout_s: float = 4.0
    max_tool_calls: int = 6
    max_llm_calls: int = 3
    max_tools: int = 6

    database_url: str = ""
    db_statement_timeout_ms: int = 3000
    db_pool_min: int = 1
    db_pool_max: int = 8
    db_search_path: str = "public"

    http_host: str = "127.0.0.1"
    http_port: int = 8000
    internal_token: str = ""
    cors_origins: tuple[str, ...] = ()
    demo_data: bool = True

    platform_base_url: str = ""
    platform_timeout_s: float = 5.0

    embedding_provider: str = "hashing"
    embedding_dim: int = 1024
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_model: str = ""

    tenant_slug: str = "hong-kong"
    default_locale: str = "zh-HK"
    timezone: str = "Asia/Hong_Kong"
    currency: str = "HKD"

    ranking_weights_path: Path = field(
        default_factory=lambda: REPO_ROOT / "infra" / "config" / "ranking_weights.yaml"
    )
    allow_platform_stub: bool = True
    offline: bool = True

    @property
    def uses_mock_llm(self) -> bool:
        return self.llm_provider == "mock"


def load_settings() -> Settings:
    provider = (_env("NEXUS_LLM_PROVIDER") or "mock").lower()
    if provider not in VALID_PROVIDERS:
        provider = "mock"

    db_url = _env("NEXUS_DATABASE_URL") or _env("DATABASE_URL") or _env("NEXUS_AI_DB_URL")
    platform = _env("NEXUS_PLATFORM_BASE_URL") or "http://127.0.0.1:8080"
    emb_provider = (_env("NEXUS_EMBEDDING_PROVIDER") or "hashing").lower()

    return Settings(
        llm_provider=provider,
        llm_base_url=_env("NEXUS_LLM_BASE_URL"),
        llm_api_key=_env("NEXUS_LLM_API_KEY"),
        llm_model_cheap=_env("NEXUS_LLM_MODEL_CHEAP"),
        llm_model_mid=_env("NEXUS_LLM_MODEL_MID"),
        llm_model_reason=_env("NEXUS_LLM_MODEL_REASON"),
        request_timeout_s=float(_env("NEXUS_REQUEST_TIMEOUT_S") or 12),
        tool_timeout_s=float(_env("NEXUS_TOOL_TIMEOUT_S") or 4),
        max_tool_calls=int(_env("NEXUS_MAX_TOOL_CALLS") or 6),
        max_llm_calls=int(_env("NEXUS_MAX_LLM_CALLS") or 3),
        max_tools=int(_env("NEXUS_MAX_TOOLS") or 6),
        database_url=db_url,
        db_statement_timeout_ms=int(_env("NEXUS_DB_STATEMENT_TIMEOUT_MS") or 3000),
        db_search_path=_env("NEXUS_DB_SEARCH_PATH") or "public",
        http_host=_env("NEXUS_AI_HOST") or "127.0.0.1",
        http_port=int(_env("NEXUS_AI_PORT") or 8000),
        internal_token=_env("NEXUS_AI_INTERNAL_TOKEN"),
        cors_origins=tuple(o.strip() for o in _env("NEXUS_AI_CORS_ORIGINS").split(",")
                          if o.strip()),
        demo_data=_env_bool("NEXUS_AI_DEMO_DATA", True),
        platform_base_url=platform,
        embedding_provider=emb_provider,
        embedding_base_url=_env("NEXUS_EMBEDDING_BASE_URL"),
        embedding_api_key=_env("NEXUS_EMBEDDING_API_KEY"),
        embedding_model=_env("NEXUS_EMBEDDING_MODEL"),
        tenant_slug=_env("NEXUS_TENANT_SLUG") or "hong-kong",
        default_locale=_env("NEXUS_DEFAULT_LOCALE") or "zh-HK",
        allow_platform_stub=_env_bool("NEXUS_ALLOW_PLATFORM_STUB", True),
        offline=provider == "mock" and emb_provider == "hashing",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()


def reset_settings_cache() -> None:
    """Tests mutate os.environ then call this."""
    clear = getattr(load_settings, "cache_clear", None)
    if clear is not None:  # load_settings is plain; only get_settings is memoised
        clear()
    get_settings.cache_clear()
