"""Test wiring: every unit test runs fully offline.

The autouse `offline_env` fixture guarantees no test can require a network, an LLM key,
or a live model — `NEXUS_DATABASE_URL` is unset (so `db_pool` stays None and the app
serves the labelled demo catalogue behind `MockAdapter`), every provider/embedding
cache is reset so a leaked configuration from another test (or the real environment)
cannot make a unit test depend on infrastructure, and the ambient proxy variables are
cleared (D1549) so no verdict depends on the shell that launched pytest.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nexus_ai.config import Settings


@pytest.fixture(autouse=True)
def offline_env(monkeypatch):
    # D1549: the four variables httpx reads to route a hop are removed before any test body runs.
    # A unit test of a timeout knob, a cache key or a pool class must not be decided by what the
    # developer's shell exports: this host's `NO_PROXY` carries a bracketed `[::1]`, which httpx
    # 0.28.1 cannot parse, and that made four live-adapter tests red with no fault in the code
    # (docs/STATUS.md §1451). A test that MEANS a proxy environment sets it itself - see
    # tests/test_d1548_internal_hop_ignores_ambient_proxy.py and test_d1549_* - and the product
    # keeps honouring the environment on the hops that leave the host.
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    monkeypatch.delenv("NEXUS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("NEXUS_LLM_PROVIDER", "mock")
    monkeypatch.delenv("NEXUS_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("NEXUS_LLM_API_KEY", raising=False)
    monkeypatch.setenv("NEXUS_EMBEDDING_PROVIDER", "hashing")
    monkeypatch.delenv("NEXUS_AI_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("NEXUS_AI_CORS_ORIGINS", raising=False)

    from nexus_ai.config import reset_settings_cache
    from nexus_ai.models import embeddings, factory
    from nexus_ai.db import pool as db_pool

    reset_settings_cache()
    factory.reset_provider_cache()
    embeddings._CACHE.clear()
    db_pool._instance = None
    yield
    db_pool._instance = None
    embeddings._CACHE.clear()
    factory.reset_provider_cache()
    reset_settings_cache()


@pytest.fixture
def settings() -> Settings:
    """An explicitly offline Settings — independent of any process env."""
    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url="", internal_token="", demo_data=True)


@pytest.fixture
def app(settings):
    from nexus_ai.api.app import create_app

    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c
