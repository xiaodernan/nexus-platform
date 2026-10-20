"""Shared HTTP-layer dependencies: settings, backend selection, model router, ledger.

One seam decides *everything* mode-related:

* `backend()` — Postgres when a pool exists (all SQL parameterised), otherwise the
  clearly-labelled demo catalogue behind `StaticBackend` (`degraded` in every response);
* `router()` — the provider pool from `models.factory`, which is `{mock}` offline and can
  never crash the app at boot (misconfiguration degrades to mock, D4);
* the same objects feed the stream and the deterministic endpoint, so §105's fallback
  target uses the identical data path minus the LLM.
"""

from __future__ import annotations

import logging
from typing import Any

from nexus_ai.api.demo_data import demo_backend
from nexus_ai.api.runs import RunLedger
from nexus_ai.config import Settings, get_settings
from nexus_ai.search.service import PostgresBackend, SearchBackend
from nexus_ai.db import pool as db_pool

log = logging.getLogger("nexus_ai.api")


class Deps:
    """Everything the routes need, resolved per app instance."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.ledger = RunLedger()
        self._router: Any = None

    # ------------------------------------------------------------------ database
    def database(self) -> Any | None:
        return db_pool.db()

    def db_available(self) -> bool:
        return db_pool.available()

    # ------------------------------------------------------------------ search
    def backend(self) -> SearchBackend:
        db = self.database()
        if db is not None:
            return PostgresBackend(db, search_path=self.settings.db_search_path)
        return demo_backend()

    def backend_degraded(self) -> bool:
        """True when we are answering from the offline demo catalogue, never live data."""
        return not self.db_available()

    # ------------------------------------------------------------------ models
    def router(self) -> Any:
        from nexus_ai.models.factory import get_router

        if self._router is None:
            self._router = get_router(self.settings)
        return self._router

    def embeddings(self) -> Any:
        from nexus_ai.models.embeddings import get_embedding_adapter

        return get_embedding_adapter(self.settings)

    # ------------------------------------------------------------------ tenant
    def tenant_id(self) -> str:
        from nexus_ai.search.service import DEFAULT_TENANT_ID

        return str(DEFAULT_TENANT_ID)


def build_deps(settings: Settings | None = None) -> Deps:
    return Deps(settings)
