"""搂0 / D3 / 搂105 鈥?the DB seam's pure guards, pinned without a database.

`nexus_ai.db.pool` is where the role split stops being documentation: SELECTs run inside a
READ ONLY transaction, only `write()` opens a write path, the search path is quoted rather
than interpolated, and a missing DSN degrades to `None` instead of crashing at import.

Everything below drives the shipped module with a fake pool/connection. The live path is
covered separately by `tests/test_integration.py` (skips when no database is reachable).
"""

from __future__ import annotations

import sys
import types

import pytest

from nexus_ai.db import pool as db_pool


# --------------------------------------------------------------------------- fakes
class FakeTransaction:
    def __init__(self, log: list[tuple[str, str]]) -> None:
        self.log = log

    async def __aenter__(self) -> "FakeTransaction":
        self.log.append(("begin", ""))
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        self.log.append(("rollback" if exc_type else "commit", ""))
        return False


class FakeAcquire:
    def __init__(self, conn: "FakeConn") -> None:
        self.conn = conn

    async def __aenter__(self) -> "FakeConn":
        return self.conn

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False


class FakeConn:
    def __init__(self, rows=None, *, fail_with: str | None = None) -> None:
        self.rows = list(rows or [])
        self.log: list[tuple[str, str]] = []
        self.fail_with = fail_with
        self.codecs: list[tuple[str, dict]] = []
        self.executed_many: list[list[tuple]] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self.log)

    async def execute(self, sql: str, *args) -> str:
        if self.fail_with:
            raise RuntimeError(self.fail_with)
        self.log.append(("execute", sql))
        return "OK"

    async def fetch(self, sql: str, *args):
        if self.fail_with:
            raise RuntimeError(self.fail_with)
        self.log.append(("fetch", sql))
        return self.rows

    async def fetchrow(self, sql: str, *args):
        self.log.append(("fetchrow", sql))
        return self.rows[0] if self.rows else None

    async def fetchval(self, sql: str, *args):
        self.log.append(("fetchval", sql))
        return self.rows[0] if self.rows else None

    async def executemany(self, sql: str, rows) -> None:
        self.log.append(("executemany", sql))
        self.executed_many.append(list(rows))

    async def set_type_codec(self, name: str, **kw) -> None:
        self.codecs.append((name, kw))


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn
        self.acquired = 0
        self.closed = 0

    def acquire(self) -> FakeAcquire:
        self.acquired += 1
        return FakeAcquire(self.conn)

    async def close(self) -> None:
        self.closed += 1


def make_db(rows=None, *, timeout: int = 3000, path: str = "public",
            fail_with: str | None = None):
    conn = FakeConn(rows, fail_with=fail_with)
    pool = FakePool(conn)
    return db_pool.Database(pool, dsn="postgresql://x", statement_timeout_ms=timeout,
                            search_path=path), pool, conn


# --------------------------------------------------------------------------- QueryResult
def test_query_result_reads_rows_by_shape():
    qr = db_pool.QueryResult(rows=[{"id": "a", "n": 1}, {"id": "b", "n": 2}],
                             columns=["id", "n"])
    assert len(qr) == 2
    assert qr.first() == {"id": "a", "n": 1}
    assert qr.scalars("id") == ["a", "b"]


def test_query_result_empty_is_none_not_index_error():
    qr = db_pool.QueryResult(rows=[], columns=["id"])
    assert len(qr) == 0
    assert qr.first() is None
    assert qr.scalars("id") == []


def test_query_result_scalars_missing_column_is_a_key_error():
    # A missing column is a programming error, not a silent None: the caller asked for a
    # column the query never selected, and hiding that would put a hole in a card.
    qr = db_pool.QueryResult(rows=[{"id": "a"}], columns=["id"])
    with pytest.raises(KeyError):
        qr.scalars("price")


# --------------------------------------------------------------------------- numeric codec
def test_to_float_accepts_none_empty_and_numbers():
    assert db_pool._to_float(None) is None
    assert db_pool._to_float("") is None
    assert db_pool._to_float("3.5") == 3.5
    assert db_pool._to_float(4) == 4.0
    assert db_pool._to_float("not-a-number") is None


# --------------------------------------------------------------------------- search_path
def test_safe_path_quotes_every_identifier():
    assert db_pool._safe_path("public") == '"public"'
    assert db_pool._safe_path("public, nexus_test") == '"public", "nexus_test"'


def test_safe_path_drops_anything_that_is_not_an_identifier():
    # The guard's job is to make an injection look like a missing schema, never like SQL.
    # With every element dropped the fallback is the bare identifier `public`.
    assert db_pool._safe_path("public; DROP TABLE merchants") == "public"
    assert db_pool._safe_path("a-b, c") == '"c"'


def test_safe_path_empty_falls_back_to_public():
    # An empty setting is spelled as `public` before the split, so it is quoted like any
    # other identifier; only a value whose every element is dropped reaches the bare
    # fallback.
    assert db_pool._safe_path("") == '"public"'
    assert db_pool._safe_path(None) == '"public"'
    assert db_pool._safe_path("   ") == "public"


def test_safe_path_keeps_digits_and_underscores():
    assert db_pool._safe_path("t_2026") == '"t_2026"'


# --------------------------------------------------------------------------- statement shape
def test_returns_rows_only_for_statements_that_return_rows():
    assert db_pool._returns_rows("SELECT 1") is False
    assert db_pool._returns_rows("SELECT * FROM merchants") is False
    assert db_pool._returns_rows("INSERT INTO agent_runs(id) VALUES ($1) RETURNING id") is True
    assert db_pool._returns_rows("  update t set a=1 returning a") is True
    assert db_pool._returns_rows("DELETE FROM t WHERE id=$1 RETURNING *") is True
    assert db_pool._returns_rows("DELETE FROM t WHERE id=$1") is False
    assert db_pool._returns_rows("") is False
    assert db_pool._returns_rows("WITH x AS (SELECT 1) SELECT * FROM x") is False
    assert db_pool._returns_rows("WITH x AS (INSERT INTO t VALUES (1) RETURNING id) "
                                 "SELECT * FROM x") is True


def test_read_only_violation_is_recognised_by_class_or_text():
    assert db_pool._is_read_only_violation(RuntimeError("cannot execute UPDATE in a "
                                                       "read-only transaction")) is True
    exc = type("ReadOnlySQLTransactionError", (Exception,), {})("nope")
    assert db_pool._is_read_only_violation(exc) is True
    assert db_pool._is_read_only_violation(RuntimeError("syntax error")) is False


def test_privilege_error_is_recognised_by_class_or_text():
    assert db_pool._is_privilege_error(RuntimeError(
        'permission denied for table merchants')) is True
    exc = type("InsufficientPrivilegeError", (Exception,), {})("nope")
    assert db_pool._is_privilege_error(exc) is True
    assert db_pool._is_privilege_error(RuntimeError("timeout")) is False


# --------------------------------------------------------------------------- constructor
def test_database_defaults_and_empty_search_path():
    db = db_pool.Database(object(), search_path="")
    assert db.search_path == "public"
    assert db.statement_timeout_ms == 3000
    assert db.read_only_violations == 0


def test_database_keeps_the_configured_knobs():
    db = db_pool.Database(object(), dsn="postgresql://x", statement_timeout_ms=750,
                          search_path="nexus_test")
    assert db.dsn == "postgresql://x"
    assert db.statement_timeout_ms == 750
    assert db.search_path == "nexus_test"


# --------------------------------------------------------------------------- read path
async def test_readonly_sets_the_read_only_flag_before_it_reads():
    db, pool, conn = make_db(rows=[{"id": "m1"}])
    out = await db.readonly("SELECT 1", "arg", schema="nexus_test")
    assert out == [{"id": "m1"}]
    # The order is the contract: READ ONLY first, path and timeout inside the transaction.
    assert [kind for kind, _ in conn.log] == ["begin", "execute", "execute", "execute",
                                              "fetch", "commit"]
    assert conn.log[1][1] == "SET TRANSACTION READ ONLY"
    assert conn.log[2][1] == 'SET LOCAL search_path TO "nexus_test"'
    assert conn.log[3][1] == "SET LOCAL statement_timeout = 3000"
    assert pool.acquired == 1


async def test_readonly_uses_the_database_search_path_when_none_is_passed():
    db, _pool, conn = make_db(path="public")
    await db.readonly("SELECT 1")
    assert conn.log[2][1] == 'SET LOCAL search_path TO "public"'


async def test_readonly_counts_a_blocked_write_and_re_raises_it():
    db, _pool, _conn = make_db(fail_with="read-only")
    with pytest.raises(RuntimeError, match="read-only"):
        await db.readonly("UPDATE merchants SET name = 'x'")
    assert db.read_only_violations == 1


async def test_readonly_translates_a_privilege_error():
    db, _pool, _conn = make_db(fail_with="permission denied for table merchants")
    with pytest.raises(db_pool.InsufficientPrivilege):
        await db.readonly("SELECT * FROM merchants")
    assert db.read_only_violations == 0


async def test_readonly_does_not_swallow_other_errors():
    db, _pool, _conn = make_db(fail_with="syntax error")
    with pytest.raises(RuntimeError, match="syntax error"):
        await db.readonly("SELECT nope")
    assert db.read_only_violations == 0


# --------------------------------------------------------------------------- write path
async def test_write_fetches_when_the_statement_returns_rows():
    db, _pool, conn = make_db(rows=[{"id": "r1"}])
    out = await db.write("INSERT INTO agent_runs(id) VALUES ($1) RETURNING id", "r1")
    assert out == [{"id": "r1"}]
    assert [kind for kind, _ in conn.log] == ["begin", "execute", "fetch", "commit"]


async def test_write_executes_when_no_rows_are_returned():
    db, _pool, conn = make_db()
    out = await db.write("UPDATE agent_runs SET status = $1", "ok")
    assert out == []
    assert [kind for kind, _ in conn.log] == ["begin", "execute", "execute", "commit"]
    assert conn.log[1][1] == "SET LOCAL statement_timeout = 3000"


async def test_insert_returning_maps_a_row_or_none():
    db, _pool, _conn = make_db(rows=[{"id": "r1"}])
    assert await db.insert_returning("INSERT ... RETURNING id") == {"id": "r1"}
    empty, _p, _c = make_db(rows=[])
    assert await empty.insert_returning("INSERT ... RETURNING id") is None


async def test_executemany_with_no_rows_never_acquires_a_connection():
    db, pool, conn = make_db()
    await db.executemany("INSERT INTO t(a) VALUES ($1)", [])
    assert pool.acquired == 0
    assert conn.executed_many == []


async def test_executemany_passes_tuples_in_column_order():
    db, _pool, conn = make_db()
    await db.executemany("INSERT INTO t(a,b) VALUES ($1,$2)",
                         [{"a": 1, "b": 2}, {"a": 3, "b": 4}])
    assert conn.executed_many == [[(1, 2), (3, 4)]]


async def test_close_swallows_a_broken_pool():
    class BadPool:
        async def close(self):
            raise RuntimeError("already closed")

    await db_pool.Database(BadPool()).close()  # must not raise


# --------------------------------------------------------------------------- codecs
async def test_init_connection_registers_jsonb_with_an_identity_encoder():
    conn = FakeConn()
    await db_pool._init_connection(conn)
    jsonb = [kw for name, kw in conn.codecs if name == "jsonb"]
    assert jsonb, "jsonb codec was never registered"
    # The identity encoder is the D-bug fix: payload text must not be double-encoded.
    assert jsonb[0]["encoder"]("{\"a\": 1}") == "{\"a\": 1}"
    assert jsonb[0]["decoder"]('{"a": 1}') == {"a": 1}
    numeric = [kw for name, kw in conn.codecs if name == "numeric"]
    assert numeric and numeric[0]["decoder"]("2.5") == 2.5


# --------------------------------------------------------------------------- module state
async def test_connect_without_a_dsn_is_none_and_does_not_import_asyncpg():
    class NoDb:
        database_url = ""

    assert await db_pool.connect(NoDb()) is None
    assert db_pool.available() is False
    assert db_pool.db() is None


async def test_connect_builds_a_pool_and_reuses_it_for_the_same_settings(monkeypatch):
    calls: list[dict] = []

    class FakeAsyncpg(types.ModuleType):
        async def create_pool(self, **kw):
            calls.append(kw)
            return FakePool(FakeConn())

    monkeypatch.setitem(sys.modules, "asyncpg", FakeAsyncpg("asyncpg"))

    class S:
        database_url = "postgresql://nexus_ai@db/nexus"
        db_pool_min = 1
        db_pool_max = 4
        db_statement_timeout_ms = 1500
        db_search_path = "public"

    s = S()
    first = await db_pool.connect(s)
    assert first is not None and first.dsn == S.database_url
    assert calls[0]["min_size"] == 1 and calls[0]["max_size"] == 4
    assert calls[0]["server_settings"]["application_name"] == "nexus_ai"
    assert calls[0]["server_settings"]["statement_timeout"] == "1500"
    second = await db_pool.connect(s)
    assert second is first
    assert len(calls) == 1, "the same settings object must not build a second pool"


async def test_force_new_closes_the_old_pool(monkeypatch):
    old_pool = FakePool(FakeConn())

    class FakeAsyncpg(types.ModuleType):
        async def create_pool(self, **kw):
            return FakePool(FakeConn())

    monkeypatch.setitem(sys.modules, "asyncpg", FakeAsyncpg("asyncpg"))

    class S:
        database_url = "postgresql://x"
        db_pool_min = 0
        db_pool_max = 2
        db_statement_timeout_ms = 3000
        db_search_path = "public"

    db_pool._instance = db_pool.Database(old_pool)
    db_pool._settings = object()
    await db_pool.connect(S(), force_new=True)
    assert old_pool.closed == 1
    assert db_pool.db() is not None


async def test_require_db_refuses_with_the_dsn_it_needs():
    db_pool._instance = None
    with pytest.raises(db_pool.DatabaseUnavailable, match="NEXUS_DATABASE_URL"):
        db_pool.require_db()


async def test_dispose_closes_and_clears_the_instance():
    pool = FakePool(FakeConn())
    db_pool._instance = db_pool.Database(pool)
    await db_pool.dispose()
    assert pool.closed == 1
    assert db_pool.available() is False
    assert db_pool.db() is None


async def test_ping_is_false_when_the_pool_cannot_answer():
    db, _pool, _conn = make_db(fail_with="fetch failed")
    assert await db.ping() is False


async def test_ping_is_true_when_it_answers():
    db, _pool, _conn = make_db(rows=[{"ok": 1}])
    assert await db.ping() is True


# --------------------------------------------------------------------------- module surface
def test_public_surface_is_explicit():
    assert set(db_pool.__all__) == {
        "Database", "DatabaseUnavailable", "InsufficientPrivilege", "QueryResult",
        "connect", "db", "require_db", "dispose", "available",
    }

