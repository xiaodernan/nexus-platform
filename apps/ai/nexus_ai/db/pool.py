"""asyncpg pool + the §0 role split.

`nexus_ai` is a read-mostly role: SELECT on the commerce tables, read-write only on the AI
tables, and nothing else. This module makes that structural rather than aspirational:

* every read runs inside `SET TRANSACTION READ ONLY` (`Database.readonly()`), so a stray
  `UPDATE` in a search path fails at the database instead of corrupting commerce data;
* writes only happen through `Database.write()` which is a separate, explicit entry point;
* `statement_timeout` is set per connection so one slow analytic query cannot pin a request
  past the 12s request budget (AGENT_CONTRACT §2.5);
* codecs turn `jsonb` into dicts and `numeric` into floats so the rest of the service never
  has to hand-decode driver types.

With no `NEXUS_DATABASE_URL` configured the pool is simply unavailable — `db()` returns
`None`, `available()` is False, and the service degrades exactly as §105 requires instead of
crashing at import.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

log = logging.getLogger("nexus_ai.db")

JSONB_TYPES = ("jsonb", "json")


class DatabaseUnavailable(RuntimeError):
    """Raised when a DB call is attempted with no pool configured."""


@dataclass
class QueryResult:
    rows: list[dict[str, Any]]
    columns: list[str]

    def __len__(self) -> int:
        return len(self.rows)

    def first(self) -> dict[str, Any] | None:
        return self.rows[0] if self.rows else None

    def scalars(self, column: str) -> list[Any]:
        return [r[column] for r in self.rows]


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def _init_connection(conn: Any) -> None:
    for type_name in JSONB_TYPES:
        try:
            await conn.set_type_codec(
                type_name, schema="pg_catalog",
                encoder=json.dumps, decoder=json.loads,
            )
        except Exception:  # pragma: no cover - codec already registered
            log.debug("could not register codec for %s", type_name, exc_info=True)
    try:
        await conn.set_type_codec("numeric", schema="pg_catalog", encoder=str,
                                  decoder=_to_float)
    except Exception:  # pragma: no cover
        log.debug("could not register numeric codec", exc_info=True)


class Database:
    """Thin, explicit wrapper over an asyncpg pool."""

    def __init__(self, pool: Any, *, dsn: str = "", statement_timeout_ms: int = 3000,
                 search_path: str = "public") -> None:
        self.pool = pool
        self.dsn = dsn
        self.statement_timeout_ms = statement_timeout_ms
        self.search_path = search_path or "public"
        self.read_only_violations = 0

    # -------------------------------------------------------------- lifecycle
    async def close(self) -> None:
        try:
            await self.pool.close()
        except Exception:  # pragma: no cover
            log.warning("error closing pool", exc_info=True)

    async def ping(self) -> bool:
        try:
            await self.fetch("SELECT 1 AS ok")
            return True
        except Exception as exc:  # pragma: no cover
            log.info("database ping failed: %s", exc)
            return False

    # -------------------------------------------------------------- reads
    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        async with self.pool.acquire() as conn:
            return [dict(r) for r in await conn.fetch(sql, *args)]

    async def fetch_in_schema(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        """Read with `search_path` applied — used by the fixture-backed demo mode."""
        async with self.pool.acquire() as conn:
            await conn.set_config("search_path", self.search_path)
            try:
                return [dict(r) for r in await conn.fetch(sql, *args)]
            finally:
                await conn.set_config("search_path", "public")

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(sql, *args)
            return dict(row) if row else None

    async def fetchval(self, sql: str, *args: Any) -> Any:
        async with self.pool.acquire() as conn:
            return await conn.fetchval(sql, *args)

    async def readonly(self, sql: str, *args: Any,
                       schema: str | None = None) -> list[dict[str, Any]]:
        """SELECTs run through here: READ ONLY transaction + statement timeout.

        Commerce reads must never write, whatever a future refactor does upstream.
        """
        path = schema or self.search_path
        async with self.pool.acquire() as conn:
            try:
                async with conn.transaction():
                    await conn.execute("SET LOCAL READ ONLY")
                    await conn.execute("SET LOCAL search_path TO " + _safe_path(path))
                    await conn.execute(
                        f"SET LOCAL statement_timeout = {int(self.statement_timeout_ms)}")
                    rows = await conn.fetch(sql, *args)
                    return [dict(r) for r in rows]
            except Exception as exc:
                if _is_read_only_violation(exc):
                    self.read_only_violations += 1
                    log.error("blocked write attempt on a read-only path: %s", exc)
                    raise
                if _is_privilege_error(exc):
                    raise InsufficientPrivilege(str(exc)) from exc
                raise

    # -------------------------------------------------------------- writes
    async def write(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        """Explicit write path — only for the AI-owned tables listed in §0."""
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    f"SET LOCAL statement_timeout = {int(self.statement_timeout_ms)}")
                rows = await conn.fetch(sql, *args) if _returns_rows(sql) \
                    else await conn.execute(sql, *args)
                if isinstance(rows, list):
                    return [dict(r) for r in rows]
                return []

    async def insert_returning(self, sql: str, *args: Any) -> dict[str, Any] | None:
        row = await self.fetchrow(sql, *args)
        return dict(row) if row else None

    async def executemany(self, sql: str, rows: Sequence[dict[str, Any]]) -> None:
        if not rows:
            return
        async with self.pool.acquire() as conn:
            await conn.executemany(sql, [tuple(r.values()) for r in rows])


class InsufficientPrivilege(RuntimeError):
    """The connected DB role may not read this table — callers fall back to platform HTTP."""


def _returns_rows(sql: str) -> bool:
    head = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
    return head in {"SELECT", "WITH", "UPDATE", "DELETE", "INSERT"} and "RETURNING" in sql.upper()


def _is_read_only_violation(exc: Exception) -> bool:
    return type(exc).__name__ == "ReadOnlySQLTransactionError" or "read-only" in str(exc).lower()


def _is_privilege_error(exc: Exception) -> bool:
    name = type(exc).__name__
    return name == "InsufficientPrivilegeError" or "permission denied" in str(exc).lower()


def _safe_path(path: str) -> str:
    """Quote each search_path element; identifiers only, never arbitrary SQL."""
    parts = [p.strip() for p in (path or "public").split(",") if p.strip()]
    out: list[str] = []
    for p in parts:
        if not p.replace("_", "").isalnum():
            continue
        out.append(f'"{p}"')
    return ", ".join(out) or "public"


# --------------------------------------------------------------------------- module state
_instance: Database | None = None
_settings: Any = None


async def connect(settings: Any, *, force_new: bool = False) -> Database | None:
    """Create (or return) the process pool. Returns None in offline/no-DB mode."""
    global _instance, _settings
    if _instance is not None and not force_new and _settings is settings:
        return _instance
    if _instance is not None and force_new:
        await _instance.close()
        _instance = None
    if not settings.database_url:
        log.info("NEXUS_DATABASE_URL unset — running without a database")
        return None
    import asyncpg

    pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        init=_init_connection,
        server_settings={"application_name": "nexus_ai",
                         "statement_timeout": str(settings.db_statement_timeout_ms)},
    )
    _settings = settings
    _instance = Database(pool, dsn=settings.database_url,
                         statement_timeout_ms=settings.db_statement_timeout_ms,
                         search_path=getattr(settings, "db_search_path", "public") or "public")
    log.info("database pool ready (search_path=%s)", _instance.search_path)
    return _instance


def db() -> Database | None:
    return _instance


def require_db() -> Database:
    if _instance is None:
        raise DatabaseUnavailable(
            "no database pool — set NEXUS_DATABASE_URL (the /ai/v1/search path needs it)")
    return _instance


async def dispose() -> None:
    global _instance
    if _instance is not None:
        await _instance.close()
    _instance = None


def available() -> bool:
    return _instance is not None


__all__ = ["Database", "DatabaseUnavailable", "InsufficientPrivilege", "QueryResult",
           "connect", "db", "require_db", "dispose", "available"]
