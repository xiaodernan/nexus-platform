"""D585 - a preference the platform let expire is not read back into the next answer.

Three planes write one promise and one reader ignores it:

* The schema writes the deadline: `IdentityRepository.upsertPreference` computes
  `expires_at = now + ttlDays` for every preference it inserts (the Java record passes
  `ttlDays` straight through from `PreferenceBody`), and the shipped types say what the
  column means - `packages/types/src/auth.ts`: "Inferred memory may expire; declared memory
  does not - V1 `expires_at`, spec §33".
* The reader is `nexus_ai/search/sql.py::user_preferences_for`, the AI lane's ONLY read of
  the table (measured: exactly one caller, `SqlBackend.user_preferences`). Measured at HEAD
  its whole WHERE is `user_id = $1::uuid` plus the optional `kind` filter - it does not
  SELECT `expires_at`, so it cannot honour it. `service.py` turns every row that comes back
  into a `pref_rules` entry, scores candidates with it AND attaches the user-visible
  `_preference_label(...)` reason to the card, so an expired memory keeps moving the ranking
  and keeps printing "because you ..." forever. D522's shape again: the reader never looked
  at the column the writer writes.
* This plane cannot show it. `data/seed/quality.sql` records the fact itself - "all seven
  preferences expire 2026-12-21, so a 'nearly expired' warning has nothing to rank" - so a
  live read is a vacuous measurement: there is no expired row here to miss.

So the gate runs the SHIPPED SQL text against a `values` list that shadows the table: same
query, same placeholders, rows this plane does not have, nothing written anywhere.

Proved to fail: deleting the predicate from the WHERE reddens both expired-row cases and the
column gate; inverting it to `expires_at is not null` reddens the two cases that must survive.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.sql as SQL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: any uuid - the rows below shadow the table, they are not looked up in it.
_USER = "11111111-2222-3333-4444-555555555555"

#: one row per state the promise covers, in the columns the read names plus the deadline.
#: `now() +/- interval` ages the fixture with the server clock instead of a pinned date that
#: would pass today and rot next month.
_MEMORY = [
    # kind, key, source, expiry SQL literal, live?, why this row is in the census
    ("style", "outdoor", "declared", "null", True,
     "a declared memory with no deadline never expires"),
    ("style", "quiet", "inferred", "now() + interval '30 days'", True,
     "an inferred memory still inside its window is live"),
    ("style", "noisy", "inferred", "now() - interval '1 day'", False,
     "an inferred memory past its window is memory the platform promised to drop"),
    ("budget", "cap_hkd", "declared", "now() - interval '40 days'", False,
     "a row carrying a passed deadline is past, whatever wrote it"),
]

live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


#: the JSONB payload column the read hands on; its content is not what this gate is about.
_VALUE = '{"value": 1}'


def _read_rows(live_settings, memory, *, kinds=None) -> list[dict]:
    """Run the lane's OWN read against a `values` list shadowing `user_preferences`.

    The CTE carries the table's name, so the shipped SQL's `FROM user_preferences` resolves
    to these rows and the real table is never read, let alone written.
    """
    from nexus_ai.db import pool as db_pool

    sql_text, params = SQL.user_preferences_for(_USER, kinds)
    tuples = ",\n              ".join(
        f"('{_USER}'::uuid, {kind!r}, {key!r}, {_VALUE!r}::jsonb, 0.9::numeric, "
        f"{source!r}, ({expiry})::timestamptz)"
        for kind, key, source, expiry, _live, _why in memory)
    query = (f"WITH user_preferences (user_id, kind, key, value, weight, source, expires_at)\n"
             f"              AS (values\n              {tuples}\n              )\n"
             f"{sql_text}")

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(query, *params)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _keys(rows) -> set[tuple[str, str]]:
    return {(r["kind"], r["key"]) for r in rows}


# ------------------------------------------------------- the read honours the deadline
@live_only
def test_a_memory_past_its_deadline_is_not_read_back(live_settings):
    """All four states in one read: the live rows back, the expired ones gone."""
    expected = {(m[0], m[1]) for m in _MEMORY if m[4]}
    got = _keys(_read_rows(live_settings, _MEMORY))
    assert got == expected, (
        f"the read returned {sorted(got)}; the promise keeps {sorted(expected)}. A row still "
        f"in this set after its expires_at has passed is still ranking the answer and still "
        f"printing its label on the card")


@live_only
def test_the_deadline_does_not_displace_the_kind_filter(live_settings):
    """`kinds` is the other half of this WHERE; one predicate must not make the reader
    forget the other."""
    got = _keys(_read_rows(live_settings, _MEMORY, kinds=["style"]))
    assert got == {("style", "outdoor"), ("style", "quiet")}, (
        f"the style read returned {sorted(got)} - either the kind filter went or the "
        f"deadline went")


@live_only
def test_the_read_names_the_column_the_promise_is_written_in(live_settings):
    """The cheapest form of the defect: before the fix `expires_at` appears nowhere in the
    built SQL, so no row could be filtered on it even in principle."""
    sql_text, _params = SQL.user_preferences_for(_USER)
    assert "expires_at" in sql_text, (
        f"the shipped read carries no expiry predicate at all:\n{sql_text}")


# ------------------------------------------------------- the plane the promise runs on
@live_only
def test_the_writer_writes_the_column_this_read_honours(live_settings):
    """A predicate aimed at a column that is not there is a green light on a dead wire."""
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(
                "select column_name, data_type from information_schema.columns "
                "where table_name = 'user_preferences' order by column_name")
        finally:
            await db_pool.dispose()

    cols = {r["column_name"]: r["data_type"] for r in asyncio.run(_go())}
    assert "expires_at" in cols, f"the table has no expiry column at all: {sorted(cols)}"
    assert cols["expires_at"].startswith("timestamp"), cols


@live_only
def test_honouring_the_deadline_leaves_this_plane_answer_unchanged(live_settings):
    """quality.sql says every seeded preference expires 2026-12-21, so all of them are live
    and the fix must not take one of them away from the demo.

    No join to `users` - the AI lane's own role is denied that table, which is why the lane
    reads preferences by user_id and leaves the tenancy to the caller.
    """
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            owners = await db.readonly("select distinct user_id from user_preferences")
            out = []
            for row in owners:
                sql_text, params = SQL.user_preferences_for(str(row["user_id"]))
                out.append((str(row["user_id"]), await db.readonly(sql_text, *params)))
            return out
        finally:
            await db_pool.dispose()

    per_owner = asyncio.run(_go())
    assert per_owner, "no preference owners on this plane - the check is vacuous"
    for user_id, rows in per_owner:
        assert rows, f"user {user_id} lost every preference once the deadline was honoured"
