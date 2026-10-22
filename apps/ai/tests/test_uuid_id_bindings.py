"""D466 — a read by ids must reach its rows in the COLUMN'S OWN TYPE, not as text.

`/ai/v1/compare` answered 503 `canceling statement due to statement timeout` on a cold
container (measured: 4.56s direct, 502 through the web BFF; three repeats once warm came back
200 in 3.99s / 0.96s / 1.17s), and the home rails reported "3 of 5 rails unavailable". The
tray that renders nothing on that answer is the consumer-visible half: the e2e selects three
cards and waits for a `table` that never arrives.

The cause was in the SQL text, not the data. Ten predicates read
`col::text = ANY($n::text[])`. `col` is `uuid` in every one of them and every one of them is
indexed on that column — so casting it makes the predicate uneindexable. EXPLAIN (ANALYZE,
BUFFERS) on the seeded corpus, through this service's own builders:

    o.id::text = ANY($2::text[])   Seq Scan on offerings  Rows Removed by Filter: 5546  1001.9 ms
    o.id       = ANY($2::uuid[])   Bitmap Index Scan on offerings_pkey                     0.07 ms
    facts      subject_id::text    Seq Scan on facts      (297 heap blocks for 14 rows)   258.4 ms
    facts      subject_id = ANY(uuid[])  Bitmap Index Scan on facts_subject_id_idx          0.71 ms

The compare read's legs summed to more than the 3000 ms this service sets for itself
(`NEXUS_DB_STATEMENT_TIMEOUT_MS`, config.py:48), so the cancel was the service enforcing its
own budget. The facts leg needed V10 as well as the bind: `facts_subject_idx` and
`facts_one_row_per_claim_uidx` both LEAD with `subject_type`, which this read cannot name
because one page mixes merchant cards and offering cards.

What is charged here: the spelling (offline, so CI sees it with no database), the shape of
every builder's bind, and the plan plus the endpoint itself against the live container.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from nexus_ai.api import runs as RUNS
from nexus_ai.search import service as SVC
from nexus_ai.search import sql as S

AI_PKG = Path(__file__).resolve().parents[1] / "nexus_ai"
TENANT = "00000000-0000-0000-0000-000000000001"
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

# The defect is an id column compared as text. A `SELECT col::text AS col` is how these rows
# leave the database (asyncpg has no uuid->str surprise in the other direction) and is not
# charged, which is why a comparison operator has to follow the cast. A NEGATIVE list
# (`id::text <> ALL(...)`, the "show me others" filter) is charged nowhere either: no btree
# index can serve `<> ANY`, so the cast costs nothing there, and the values come from a
# request field this service does not validate as uuids.
# A line that is only a comment is exempt: prose here quotes the old spelling to explain the
# rule (sql.py:413-419), and a door that charges its own documentation cannot be read.
ID_CAST_EQUALITY = re.compile(r"\b[\w.]*(?:_id|\bid)\s*::\s*text\s*=")
ID_EQ_ANY_UUID = re.compile(r"\b([\w.]*(?:_id|\bid)) = ANY\(")
COMMENT = re.compile(r"^\s*#")

# The by-ids predicates this fix repaired, counted in the shipped file. The mutation arm has to
# find this many to be an arm at all: if a builder's spelling moves, the arm that proves the door
# can bite quietly stops mutating anything.
BY_IDS_PREDICATES_IN_SQL_PY = 8


def _ids(n: int = 3) -> list[str]:
    return [str(uuid.uuid4()) for _ in range(n)]


def _sources() -> list[Path]:
    return sorted(p for p in AI_PKG.rglob("*.py") if "__pycache__" not in p.parts)


def _charges(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not COMMENT.match(stripped) and bool(
        ID_CAST_EQUALITY.search(stripped))


# --------------------------------------------------------------------- the door (offline)
def test_no_id_column_is_compared_as_text_anywhere_in_the_ai_service():
    offenders = [f"{path.relative_to(AI_PKG)}:{number}: {line.strip()}"
                 for path in _sources()
                 for number, line in enumerate(
                     path.read_text(encoding="utf-8").splitlines(), start=1)
                 if _charges(line)]
    assert not offenders, (
        "a predicate casts an id column to text for a comparison, which no index on that "
        "column can serve:\n  " + "\n  ".join(offenders))


def _restore_the_old_spelling(src: str) -> tuple[str, int]:
    """The inverse of the fix, derived from the shipped bytes rather than hand-copied.

    Only a non-comment line that binds a `uuid[]` array is touched, so the arm mutates the eight
    predicates this file exists for and leaves the prose and the negative lists alone.
    """
    out, sites = [], 0
    for line in src.splitlines(keepends=True):
        if "::uuid[]" in line and not COMMENT.match(line):
            new, n = ID_EQ_ANY_UUID.subn(r"\1::text = ANY(", line)
            if n:
                sites += n
                line = new.replace("::uuid[]", "::text[]")
        out.append(line)
    return "".join(out), sites


@pytest.mark.parametrize("mutate", [True, False])
def test_the_door_reddens_only_when_a_predicate_goes_back_to_text(
        tmp_path, monkeypatch, mutate):
    """The arm, both ways: the same package copy reddens the shipped door with the old
    spelling and greens it without one. A one-way arm cannot tell a bite from a crash."""
    shipped = (AI_PKG / "search" / "sql.py").read_text(encoding="utf-8")
    mutated, sites = _restore_the_old_spelling(shipped)
    assert sites == BY_IDS_PREDICATES_IN_SQL_PY, (
        f"the arm meant to restore {BY_IDS_PREDICATES_IN_SQL_PY} predicates and found {sites} "
        "- the shipped spelling moved, so the door's bite is no longer being measured")
    assert sum(1 for line in mutated.splitlines() if _charges(line)) == sites
    if not mutate:
        assert not any(_charges(line) for line in shipped.splitlines())

    arm = tmp_path / "nexus_ai"
    arm.mkdir()
    (arm / "sql.py").write_text(mutated if mutate else shipped, encoding="utf-8")
    monkeypatch.setitem(globals(), "AI_PKG", arm)

    if mutate:
        with pytest.raises(AssertionError) as excinfo:
            test_no_id_column_is_compared_as_text_anywhere_in_the_ai_service()
        message = str(excinfo.value)
        assert "sql.py" in message, message
        # Read the report's own offender rows (indented `sql.py:<n>: <line>`), not a substring
        # count: pytest appends the failing list's repr to the message, and that repr contains
        # the same spellings again.
        charged = re.findall(r"^\s+sql\.py:\d+: .*$", message, re.MULTILINE)
        assert len(charged) == sites, message
        assert all("::text = ANY" in line for line in charged), message
    else:
        test_no_id_column_is_compared_as_text_anywhere_in_the_ai_service()


@pytest.mark.parametrize("spelling", [
    "WHERE subject_id::text = ANY($1::text[])",
    "FROM business_hours WHERE merchant_id::text = ANY($2::text[])",
    "  AND r2.merchant_id::text = ANY($3::text[])",
    "WHERE m.tenant_id = $1::uuid AND o.id::text = ANY($2::text[])",
    "WHERE user_id::text = $1::uuid",
    "WHERE conversation_id::text = $1::text",
])
def test_the_door_charges_every_shape_of_the_old_spelling(spelling):
    # Positive control: the reader, run over the ten pre-fix spellings it exists to catch,
    # finds every one. A door that matches nothing greens the next refactor.
    assert _charges(spelling), f"the door is blind to: {spelling}"


@pytest.mark.parametrize("spelling", [
    "SELECT id::text AS fact_id, subject_id::text AS subject_id,",
    "WHERE subject_id = ANY($1::uuid[])",
    "WHERE m.id = $2::uuid",
    "WHERE merchant_id::text <> ALL($1::text[])",
    "array(select i::text from unnest(fact_ids) i) AS fact_ids",
    "# `o.id::text = ANY($n::text[])` is the spelling that caused D466",
])
def test_the_door_does_not_charge_the_shapes_that_are_not_the_defect(spelling):
    # The other half of the control: exempt spellings stay exempt by rule, not by accident.
    assert not _charges(spelling)


# --------------------------------------------------------------------- the binds (offline)
@pytest.mark.parametrize("builder,args", [
    (S.facts_for, (_ids(),)),
    (S.hours_for, (_ids(),)),
    (S.slots_for, (_ids(), datetime.now(), datetime.now() + timedelta(hours=3), 2)),
    (S.reviews_for, (_ids(),)),
    (S.entities_for, (TENANT, _ids())),
    (S.compare_geo, (TENANT, _ids(), 22.3809, 114.1861)),
])
def test_every_by_ids_builder_binds_its_ids_as_a_uuid_array(builder, args):
    ids = args[1] if builder in (S.entities_for, S.compare_geo) else args[0]
    sql, params = builder(*args)
    assert sql, f"{builder.__name__} built nothing for {ids}"
    assert "::text = ANY" not in sql, f"{builder.__name__} still compares ids as text"
    assert sql.count("= ANY($") >= 1, f"{builder.__name__} has no bound array: {sql}"
    assert "::uuid[]" in sql, f"{builder.__name__} does not bind uuid[]: {sql}"
    # Nothing is inlined: the ids travel as a bound list, so a stray quote cannot become SQL.
    for one in ids:
        assert one not in sql
    assert any(p == ids for p in params), params


def test_the_two_single_value_id_reads_bind_the_uuid_type():
    assert "conversation_id = $1::uuid" in RUNS.CONVERSATION_RUNS_SQL, (
        "the conversation timeline is back to comparing a uuid column as text")

    recorder = _RecordingDatabase()
    asyncio.run(SVC.PostgresBackend(recorder, search_path="public")
                .feedback(_ids(1)[0], _ids()))
    sql_text, args = recorder.calls[0]
    assert "user_id = $1::uuid AND subject_id = ANY($2::uuid[])" in sql_text, sql_text
    assert isinstance(args[1], list) and all(isinstance(x, str) for x in args[1]), args


class _RecordingDatabase:
    """Stands in for the pool: captures the statement the production method builds."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list]] = []

    async def readonly(self, sql: str, *params, schema: str | None = None):
        self.calls.append((sql, list(params)))
        return []


# --------------------------------------------------------------------- the plane (live)
def _live_cases() -> list[tuple[str, str, str, list]]:
    """(label, table-the-predicate-filters, sql, args) for every by-ids read this service ships.

    The SQL comes from the production builders, and the feedback statement from the
    production method itself via the recorder — nothing here retypes a predicate, so a
    builder change is what this test sees.
    """
    m, sids, now = _ids(2), _ids(3), datetime.now()
    recorder = _RecordingDatabase()
    asyncio.run(SVC.PostgresBackend(recorder, search_path="public")
                .feedback(_ids(1)[0], sids))
    cases = [(name, table, *builder(*args)) for name, table, builder, args in [
        ("entities_for", "offerings", S.entities_for, (TENANT, sids)),
        ("facts_for", "facts", S.facts_for, (sids,)),
        ("hours_for", "business_hours", S.hours_for, (m,)),
        ("slots_for", "availability_slots", S.slots_for,
         (m, now, now + timedelta(hours=3), 2)),
        ("reviews_for", "reviews", S.reviews_for, (m,)),
        ("compare_geo", "merchants", S.compare_geo, (TENANT, m, 22.3809, 114.1861)),
    ]]
    cases.append(("conversation_timeline", "agent_runs", RUNS.CONVERSATION_RUNS_SQL,
                  [_ids(1)[0]]))
    cases.append(("feedback", "feedback_events", *recorder.calls[0]))
    return [(label, table, sql_text, params)
            for label, table, sql_text, params in cases if sql_text]


@pytest.mark.integration
def test_the_live_plans_reach_their_rows_by_index():
    """No by-ids read may sequential-scan a table the corpus actually makes large.

    The floor is measured, not chosen to pass: it sits below the smallest table this lane
    reads by id (agent_runs, 1295 rows) and above the tables where a sequential scan really is
    the cheapest plan (feedback_events, 4 rows). The counts come from the same connection, so a
    change in the corpus moves the population instead of silently exempting a table.
    """
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncpg

    cases = _live_cases()

    async def measure() -> tuple[dict[str, tuple[str, str]], dict[str, int]]:
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("SET statement_timeout = '20000ms'")
            counts = {table: await conn.fetchval(f"SELECT count(*) FROM {table}")
                      for _, table, _, _ in cases}
            plans = {}
            for label, table, sql_text, params in cases:
                rows = await conn.fetch("EXPLAIN (ANALYZE, BUFFERS) " + sql_text, *params)
                plans[label] = (table, "\n".join(r[0] for r in rows))
            return plans, counts
        finally:
            await conn.close()

    plans, counts = asyncio.run(measure())
    offenders = sorted(f"  {label}: Seq Scan on {table} ({counts[table]} rows)"
                       for label, (table, plan) in plans.items()
                       if f"Seq Scan on {table}" in plan and counts[table] >= 1000)
    assert not offenders, (
        "by-ids reads that still walk a large table page by page:\n" + "\n".join(offenders))


@pytest.mark.integration
def test_compare_answers_inside_the_services_own_statement_budget():
    """The endpoint that 503'd, answered against the real corpus.

    This is also the witness that asyncpg encodes this service's string ids for a `uuid[]`
    parameter: every builder above binds strings, and a refusal would surface here as a 503.
    """
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncpg

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    async def pick() -> list[str]:
        conn = await asyncpg.connect(DB_URL)
        try:
            rows = await conn.fetch(
                "SELECT id::text AS id FROM merchants WHERE status='published' ORDER BY id LIMIT 3")
        finally:
            await conn.close()
        return [r["id"] for r in rows]

    subject_ids = asyncio.run(pick())
    assert len(subject_ids) >= 2, "the corpus has no published merchants to compare"
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as client:
        started = time.perf_counter()
        response = client.post("/ai/v1/compare", json={
            "subject_ids": subject_ids,
            "geo": {"lat": 22.3809, "lng": 114.1861},
            "locale": "zh-HK"})
        elapsed_ms = (time.perf_counter() - started) * 1000

    assert response.status_code == 200, (
        f"compare answered {response.status_code} in {elapsed_ms:.0f} ms: {response.text}")
    assert elapsed_ms < settings.db_statement_timeout_ms, (
        f"compare took {elapsed_ms:.0f} ms against a "
        f"{settings.db_statement_timeout_ms} ms statement budget")
    body = response.json()
    assert body.get("source") == "postgres", body
    assert body.get("degraded") is False, body
    assert len(body.get("rows") or []) >= 2, body
