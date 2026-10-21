"""Contract tests for ``nexus_ai.api.deps`` — the HTTP layer's offline/degrade wiring (§105, D4).

`Deps` is the one seam that decides mode: with no DB pool it must answer from the clearly-labelled
demo catalogue (`StaticBackend`, `degraded`), the router must degrade to `mock`, and embeddings
must degrade to `hashing`. None of this touches a real database or network.

Every assertion was confirmed against the running modules (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.api.deps as D
from nexus_ai.config import Settings
from nexus_ai.models.embeddings import HashingEmbedding
from nexus_ai.models.mock import MockAdapter
from nexus_ai.models.router import ModelRouter
from nexus_ai.search.service import DEFAULT_TENANT_ID, StaticBackend


class TestNoDatabaseDegrade:
    def test_database_is_none_without_pool(self):
        d = D.Deps(Settings())
        assert d.database() is None

    def test_db_unavailable_and_degraded(self):
        d = D.Deps(Settings())
        assert d.db_available() is False
        assert d.backend_degraded() is True


class TestBackendSelection:
    def test_no_pool_uses_static_demo_backend(self):
        b = D.Deps(Settings()).backend()
        assert isinstance(b, StaticBackend)
        assert b.name == "static"


class TestModelDegrade:
    def test_router_degrades_to_mock(self):
        r = D.Deps(Settings()).router()
        assert isinstance(r, ModelRouter)
        assert any(isinstance(a, MockAdapter) for a in r.adapters)

    def test_embeddings_degrade_to_hashing(self):
        e = D.Deps(Settings()).embeddings()
        assert isinstance(e, HashingEmbedding)
        assert e.name == "hashing"


class TestTenant:
    def test_default_tenant_id(self):
        assert D.Deps(Settings()).tenant_id() == str(DEFAULT_TENANT_ID)


class TestBuildDeps:
    def test_build_deps_returns_deps_with_settings(self):
        s = Settings()
        d = D.build_deps(s)
        assert isinstance(d, D.Deps)
        assert d.settings is s
