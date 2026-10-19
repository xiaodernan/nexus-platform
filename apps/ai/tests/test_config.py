"""Contract tests for ``nexus_ai.config`` — environment-backed settings (DECISIONS D4/D5).

Every knob has a safe offline default so the suite runs with no env vars and no network. These
tests pin that: defaults, provider validation/fallback, the DB-URL priority order, boolean parsing,
CORS parsing, the `offline` derivation, and the `get_settings` cache/reset contract.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.config as C


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Isolate each test from the ambient environment."""
    for key in list(os.environ):
        if key.startswith("NEXUS_") or key == "DATABASE_URL":
            monkeypatch.delenv(key, raising=False)
    C.reset_settings_cache()
    yield
    C.reset_settings_cache()


class TestDefaults:
    def test_safe_offline_defaults(self):
        s = C.load_settings()
        assert s.llm_provider == "mock"
        assert s.offline is True
        assert s.uses_mock_llm is True
        assert s.embedding_provider == "hashing"

    def test_network_and_db_defaults(self):
        s = C.load_settings()
        assert s.http_host == "127.0.0.1"
        assert s.http_port == 8000
        assert s.database_url == ""
        assert s.platform_base_url == "http://127.0.0.1:8080"

    def test_product_defaults(self):
        s = C.load_settings()
        assert s.demo_data is True
        assert s.allow_platform_stub is True
        assert s.tenant_slug == "hong-kong"
        assert s.default_locale == "zh-HK"
        assert s.cors_origins == ()

    def test_ranking_weights_path_points_at_repo_config(self):
        p = str(C.load_settings().ranking_weights_path).replace("\\", "/")
        assert p.endswith("infra/config/ranking_weights.yaml")


class TestProviderValidation:
    def test_invalid_provider_falls_back_to_mock(self, monkeypatch):
        monkeypatch.setenv("NEXUS_LLM_PROVIDER", "BOGUS")
        assert C.load_settings().llm_provider == "mock"

    def test_anthropic_provider_is_live_and_not_offline(self, monkeypatch):
        monkeypatch.setenv("NEXUS_LLM_PROVIDER", "anthropic")
        s = C.load_settings()
        assert s.llm_provider == "anthropic"
        assert s.uses_mock_llm is False
        assert s.offline is False

    def test_openai_provider(self, monkeypatch):
        monkeypatch.setenv("NEXUS_LLM_PROVIDER", "openai")
        assert C.load_settings().llm_provider == "openai"


class TestDatabaseUrlPriority:
    def test_nexus_database_url_wins(self, monkeypatch):
        monkeypatch.setenv("NEXUS_DATABASE_URL", "postgres://nexus")
        monkeypatch.setenv("DATABASE_URL", "postgres://db")
        monkeypatch.setenv("NEXUS_AI_DB_URL", "postgres://ai")
        assert C.load_settings().database_url == "postgres://nexus"

    def test_database_url_is_second(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgres://db")
        monkeypatch.setenv("NEXUS_AI_DB_URL", "postgres://ai")
        assert C.load_settings().database_url == "postgres://db"

    def test_nexus_ai_db_url_is_third(self, monkeypatch):
        monkeypatch.setenv("NEXUS_AI_DB_URL", "postgres://ai")
        assert C.load_settings().database_url == "postgres://ai"


class TestEnvBool:
    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on"])
    def test_truthy_values(self, monkeypatch, raw):
        monkeypatch.setenv("NEXUS_AI_DEMO_DATA", raw)
        assert C.load_settings().demo_data is True

    @pytest.mark.parametrize("raw", ["0", "false", "no"])
    def test_falsey_values(self, monkeypatch, raw):
        monkeypatch.setenv("NEXUS_AI_DEMO_DATA", raw)
        assert C.load_settings().demo_data is False

    def test_empty_uses_default(self, monkeypatch):
        monkeypatch.setenv("NEXUS_AI_DEMO_DATA", "")
        assert C.load_settings().demo_data is True


class TestCorsParsing:
    def test_comma_list_trimmed_and_empty_dropped(self, monkeypatch):
        monkeypatch.setenv("NEXUS_AI_CORS_ORIGINS", "http://a.com, http://b.com ,")
        assert C.load_settings().cors_origins == ("http://a.com", "http://b.com")

    def test_empty_is_empty_tuple(self):
        assert C.load_settings().cors_origins == ()


class TestNumericEnv:
    def test_port_and_limits(self, monkeypatch):
        monkeypatch.setenv("NEXUS_AI_PORT", "8010")
        monkeypatch.setenv("NEXUS_MAX_LLM_CALLS", "5")
        s = C.load_settings()
        assert s.http_port == 8010
        assert s.max_llm_calls == 5


class TestSettingsCache:
    def test_get_settings_is_cached(self):
        a = C.get_settings()
        b = C.get_settings()
        assert a is b

    def test_reset_picks_up_env_change(self, monkeypatch):
        assert C.get_settings().llm_provider == "mock"
        monkeypatch.setenv("NEXUS_LLM_PROVIDER", "openai")
        # still cached until reset
        assert C.get_settings().llm_provider == "mock"
        C.reset_settings_cache()
        assert C.get_settings().llm_provider == "openai"
