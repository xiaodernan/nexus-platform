"""D604 - the memory tier a caller chooses is stored, shown to its owner, and read by nobody.

`user_preferences` has two columns that say HOW LONG a preference lives:

* `scope text NOT NULL DEFAULT 'long_term' -- session|long_term`
  (`infra/db/migrations/V1__init.sql:69`), and the shipped API lets the caller pick either:
  `PreferenceBody`'s `@Pattern(regexp = "^(session|long_term)$")`, exposed to clients as
  `scope?: "session" | "long_term"` with the comment "Memory tier - V1 `scope`
  (`session|long_term`), spec §117" (`packages/types/src/auth.ts:206`).
* `conversation_id uuid`, nullable, the key that would tie a row to the conversation that made it
  (`V1__init.sql:70`).

`docs/AGENTS.md` §6 draws the line those two columns sit on: four memory scopes with permission
isolation, **session** memory being `conversations.state` and **user-preference** memory being
`user_preferences` with "scope `session|long_term`, user view/edit/delete - §32/§33".

The read that feeds the ranking is `nexus_ai/search/sql.py::user_preferences_for` - the AI lane's
only read of this table (measured: the word `scope` appears nowhere in `nexus_ai`, and the one
caller is `SqlBackend.user_preferences`). It selects `kind, key, value, weight, source` and its
WHERE is `user_id` plus D585's deadline predicate plus the optional `kind` list. So the two tiers
are one tier to the ranker: a preference the caller scoped to one conversation ranks every future
answer forever, and the user is told about that tier anyway, because `listPreferences` selects
`p.scope` straight into the §32 list. D522's shape a third time - the reader not looking at the
column the writer writes - except here the column is not merely unread, it is unkeyable: the
shipped writer never populates `conversation_id`, and `PreferenceBody` has no field for it, so a
reader that wanted to honour the tier would have nothing to honour it against.

This plane cannot show a victim: measured for this file, all 7 preference rows are `long_term` and
all 7 carry a NULL `conversation_id` (`data/seed/generate.py` writes `"long_term", None` for every
row), so the first caller to send `scope="session"` through the shipped API is the first victim.
The gate therefore runs the SHIPPED SQL text against a `values` list that shadows the table -
D585's technique - and nothing is written anywhere.

What is asserted is the gap, not a chosen repair: honouring the tier (filter the read, key it on
`conversation_id`) or refusing the value at the door are different products, and the pair of
columns makes the choice one decision rather than two clauses (D545). Filed in PLAN.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import pytest

import nexus_ai.search.sql as SQL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

_ROOT = Path(__file__).resolve().parents[3]
_IDENTITY = _ROOT / "services" / "platform" / "src" / "main" / "java" / "com" / "nexus" \
    / "identity" / "IdentityRepository.java"
_ME = _ROOT / "services" / "platform" / "src" / "main" / "java" / "com" / "nexus" \
    / "identity" / "MeController.java"

#: any uuid - the rows below shadow the table, they are not looked up in it.
_USER = "11111111-2222-3333-4444-555555555555"
#: a conversation the session row claims to belong to, so the read cannot blame the row for having
#: no key to honour.
_CONV = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

#: (kind, key, value, weight, source, scope, conversation_id, what this row is for)
_MEMORY = [
    ("style", "ambience", '{"value": "quiet"}', 0.7, "declared", "long_term", None,
     "the durable tier the ranker is meant to read"),
    ("view", "scenic", '{"value": true}', 0.7, "declared", "session", _CONV,
     "a preference the caller scoped to ONE conversation, carrying its conversation key"),
    ("budget", "per_person_max_hkd", '{"value": 200}', 0.7, "declared", "session", None,
     "the same tier as written by the shipped API, which cannot set a conversation at all"),
]

live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


def _java_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    assert len(text) > 1_000, f"{path.name} is not the file this gate reads"
    return text


def _preference_insert_columns() -> list[str]:
    """The column list of the shipped preference INSERT, read off the writer's own SQL."""
    match = re.search(r"insert into user_preferences \(([^)]*)\)", _java_text(_IDENTITY), re.S)
    assert match, (
        "the preference INSERT is no longer a plain column list in IdentityRepository.java - the "
        "writer this gate cross-checks has moved somewhere nobody reads")
    return [c.strip() for c in match.group(1).split(",") if c.strip()]


def _preference_body_text() -> str:
    """The request body a caller must satisfy to write a preference, read off its own record."""
    match = re.search(r"record PreferenceBody\((.*?)\)\s*\{", _java_text(_ME), re.S)
    assert match, (
        "`PreferenceBody` is no longer a one-record request body in MeController.java - the door "
        "that decides what a caller may state has moved somewhere nobody reads")
    return match.group(1)


def _scope_tiers_the_api_admits() -> list[str]:
    """The `scope` @Pattern's admitted values, read inside `PreferenceBody` and nowhere else.

    Scoped to the record on purpose: D588's reader of this file's other `@Pattern` first matched a
    LATER one in the same file and silently swallowed half the list.
    """
    match = re.search(r'@Pattern\(regexp = "\^\(([^")]*)\)\$"\)\s*String scope',
                      _preference_body_text())
    assert match, (
        "`scope` no longer carries a one-line (a|b)@Pattern inside PreferenceBody - the door that "
        "decides which tiers a caller may choose has changed shape and this gate is now blind")
    return [t.strip() for t in match.group(1).split("|") if t.strip()]


def _read_rows(live_settings, memory, *, kinds=None) -> list[dict]:
    """Run the lane's OWN read against a `values` list shadowing `user_preferences`.

    The CTE carries the table's name, so the shipped SQL's `FROM user_preferences` resolves to
    these rows and the real table is never read, let alone written.
    """
    from nexus_ai.db import pool as db_pool

    sql_text, params = SQL.user_preferences_for(_USER, kinds)
    tuples = ",\n              ".join(
        f"('{_USER}'::uuid, {kind!r}, {key!r}, {value!r}::jsonb, {weight}::numeric, "
        f"{source!r}, {scope!r}, {'null::uuid' if conv is None else repr(conv) + '::uuid'}, "
        f"null::timestamptz)"
        for kind, key, value, weight, source, scope, conv, _why in memory)
    query = (
        f"WITH user_preferences (user_id, kind, key, value, weight, source, scope, "
        f"conversation_id, expires_at)\n"
        f"              AS (values\n              {tuples}\n              )\n"
        f"{sql_text}")

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(query, *params)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _keys(rows) -> set[str]:
    return {r["key"] for r in rows}


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


# ------------------------------------------------------------- the reader's view of the tier
def test_the_ranking_read_names_neither_column_the_tier_lives_in():
    """The cheapest form of the defect, read off the built SQL rather than remembered.

    `weight`/`source`/`expires_at` are all decisions this lane already made about which columns the
    ranker owes; `scope` and `conversation_id` are the two it has never looked at.
    """
    sql_text, _params = SQL.user_preferences_for(_USER)
    assert "scope" not in sql_text and "conversation_id" not in sql_text, (
        f"the preference read now names the tier - it says:\n{sql_text}\nif the tier is honoured, "
        f"this row has done its job: fold it into the shadow read below rather than restoring "
        f"the premise")


@live_only
def test_a_preference_scoped_to_one_conversation_is_read_back_by_every_search(live_settings):
    """The two tiers arrive as one set, whether or not the session row knows its conversation."""
    got = _keys(_read_rows(live_settings, _MEMORY))
    assert got == {"ambience", "scenic", "per_person_max_hkd"}, (
        f"the shipped read returned {sorted(got)} for a user holding one durable preference and "
        f"two scoped to a session - the session rows are being kept as durable memory. A fix "
        f"that honours the tier should drop BOTH session rows out of this set, and this row goes "
        f"red on purpose: the repair is filed in PLAN, not silently absorbed")


@live_only
def test_the_shadow_read_is_not_vacuous(live_settings):
    """A gate whose reader answered nothing would pass the row above with an empty set."""
    durable = [r for r in _MEMORY if r[5] == "long_term"]
    assert _keys(_read_rows(live_settings, durable)) == {"ambience"}, (
        "the read does not even return a plain long-term row - the shadow is not reaching the "
        "shipped SQL and every row above this one is measuring nothing")


# ------------------------------------------------------------- the writer's view of the tier
def test_the_tier_the_caller_chose_is_the_tier_that_is_stored():
    """The write plane is NOT the half that ignores this - so the claim stays pointed at the read."""
    assert "scope" in _preference_insert_columns(), (
        "the preference INSERT no longer names `scope`, so the caller's tier is not even being "
        "stored and the defect has moved somewhere else entirely")
    tiers = _scope_tiers_the_api_admits()
    assert tiers == ["session", "long_term"], (
        f"PreferenceBody admits {tiers} - this gate's claim is about exactly the two tiers the "
        f"DDL comments (`session|long_term`) and the contract names, so a widened or narrowed "
        f"list is a change to what the read owes")


def test_the_shipped_writer_cannot_give_a_session_row_a_conversation():
    """The tier is storable; the key that would make it honourable is not. One gap, not two."""
    cols = _preference_insert_columns()
    assert "conversation_id" not in cols, (
        f"the preference INSERT now writes {cols} - if `conversation_id` is being populated the "
        f"tier has acquired its mechanism and the repair PLAN asked for is half-done; re-read "
        f"this file against that writer")
    assert "conversation" not in _preference_body_text(), (
        "PreferenceBody now carries a conversation field, so a caller can name the conversation "
        "their session preference belongs to - same instruction as above")


def test_the_owner_is_shown_the_tier_the_ranker_ignores():
    """§32 makes the row visible and editable, and the list does show which tier it is."""
    assert "p.scope" in _java_text(_IDENTITY), (
        "the preference list no longer selects `p.scope`, so the user is no longer told which "
        "tier they chose - that is a different defect from this one and needs its own row")


# ------------------------------------------------------------- this plane, measured
@live_only
def test_this_plane_has_no_session_row_yet(live_settings):
    """The count that keeps the rows above honest about what is a victim and what is a promise.

    No join to `users` - the AI lane's own role is denied that table (measured: permission denied),
    which is why the lane reads preferences by user_id and leaves the tenancy to the caller.
    """
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(
                "select scope, count(*) n, count(conversation_id) with_conv "
                "from user_preferences group by scope order by scope")
        finally:
            await db_pool.dispose()

    rows = asyncio.run(_go())
    assert rows, "no preference rows on this plane at all - this census has nothing to say"
    by_scope = {r["scope"]: (r["n"], r["with_conv"]) for r in rows}
    assert set(by_scope) == {"long_term"}, (
        f"this plane now holds {by_scope} - a session-tier row exists, so the defect above has a "
        f"live victim and the measurement it needs is the real one, not the shadow")
    assert all(with_conv == 0 for _n, with_conv in by_scope.values()), (
        f"some durable rows now carry a conversation key ({by_scope}) - the writer can populate "
        f"it after all, so re-read `test_the_shipped_writer_cannot_give_a_session_row_a_"
        f"conversation` against that writer")
