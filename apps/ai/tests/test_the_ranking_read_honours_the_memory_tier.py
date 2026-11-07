"""D742 - the ranking read is wired to the memory tier, not just the SQL primitive.

D723/D604 taught `user_preferences_for` to filter by `scope` and `conversation_id`, but the
only callers passed neither: `service.search()` read `backend.user_preferences(user_id)`
unfiltered, so session-tier memory (including rows scoped to one conversation) still ranked
every later answer forever. This gate holds the wiring shut:

* `service.search()` forwards its `conversation_id` kwarg to the backend's preference read;
* `PostgresBackend.user_preferences` reads long-term memory ALWAYS, plus the session rows
  bound to the conversation when one is given (never unbound session rows);
* `StaticBackend` accepts the `conversation_id` kwarg (the protocol's shared shape);
* a session row whose (kind, key) duplicates a durable row is not double-counted.
"""

from __future__ import annotations

import asyncio
import inspect

import nexus_ai.search.service as S


def test_search_forwards_conversation_id_to_the_preference_read():
    async def _go():
        seen = {}

        class Backend(S.StaticBackend):
            async def user_preferences(self, user_id, kinds=None, conversation_id=None):
                seen["user_id"] = user_id
                seen["conversation_id"] = conversation_id
                return []

            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return []

            async def offering_candidates(self, *, text=None, filters=None, **_kw):
                return []

        b = Backend()
        plan = S.SearchPlan(query_text="place", limit=10)
        await S.search(backend=b, plan=plan, user_id="11111111-2222-3333-4444-555555555555",
                       conversation_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        return seen

    seen = asyncio.run(_go())
    assert seen["conversation_id"] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", seen


class _FakeDB:
    """Rows are distinguished solely by the scope parameter in the bound query."""

    def __init__(self, durable, session):
        self.durable = durable
        self.session = session
        self.calls = []

    async def readonly(self, sql, *params, schema=None):
        self.calls.append(params)
        if "session" in params:
            return [dict(r) for r in self.session]
        if "long_term" in params:
            return [dict(r) for r in self.durable]
        raise AssertionError(f"scope not bound in query: {params}")


def _backend(durable, session):
    db = _FakeDB(durable, session)
    return S.PostgresBackend(db, search_path="public"), db


def _run(backend, conversation_id):
    async def _go():
        return await backend.user_preferences(
            "11111111-2222-3333-4444-555555555555", conversation_id=conversation_id)

    return asyncio.run(_go())


def test_long_term_memory_is_read_and_session_memory_is_not_by_default():
    backend, db = _backend(
        [{"kind": "style", "key": "ambience", "value": "{}", "weight": 0.7,
          "source": "declared"}],
        [{"kind": "budget", "key": "per_person_max_hkd", "value": "{}", "weight": 0.7,
          "source": "declared"}])
    rows = _run(backend, None)
    assert [r["key"] for r in rows] == ["ambience"], rows
    assert all("long_term" in call for call in db.calls), db.calls


def test_session_memory_bound_to_this_conversation_ranks_this_conversation():
    backend, _db = _backend(
        [{"kind": "style", "key": "ambience", "value": "{}", "weight": 0.7,
          "source": "declared"}],
        [{"kind": "budget", "key": "per_person_max_hkd", "value": "{}", "weight": 0.7,
          "source": "declared"}])
    rows = _run(backend, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    assert {r["key"] for r in rows} == {"ambience", "per_person_max_hkd"}, rows


def test_session_memory_never_outranks_unbound_by_being_silently_merged():
    backend, db = _backend(
        [{"kind": "style", "key": "ambience", "value": "{}", "weight": 0.7,
          "source": "declared"}],
        [{"kind": "style", "key": "ambience", "value": "{}", "weight": 0.8,
          "source": "declared"}])
    rows = _run(backend, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    # the durable row wins (or was seen first); no duplicate (kind, key) pair
    assert [(r["kind"], r["key"]) for r in rows].count(("style", "ambience")) == 1, rows


def test_an_unparseable_conversation_is_not_read_as_anything_at_all():
    backend, db = _backend(
        [{"kind": "style", "key": "ambience", "value": "{}", "weight": 0.7,
          "source": "declared"}],
        [{"kind": "view", "key": "scenic", "value": "{}", "weight": 0.7,
          "source": "declared"}])
    rows = _run(backend, "not-a-uuid")
    assert [r["key"] for r in rows] == ["ambience"], rows
    assert all("session" not in call for call in db.calls), db.calls


def test_static_backend_accepts_the_conversation_keyword():
    b = S.StaticBackend()
    out = asyncio.run(b.user_preferences("u", conversation_id="c"))
    assert out == []


def test_the_protocol_declares_the_keyword():
    sig = inspect.signature(S.SearchBackend.user_preferences)
    assert "conversation_id" in sig.parameters
