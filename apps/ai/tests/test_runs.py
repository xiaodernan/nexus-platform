"""Contract tests for ``nexus_ai.api.runs`` — the run ledger + AI-write guard (AGENT_CONTRACT §8).

Two DB-free concerns:
* the in-memory ``RunLedger`` ring that answers the conversation timeline offline;
* the ``_check_table`` guard that refuses to write any table outside the AI-owned grant set
  (API_CONTRACT §0, D19/D20) — a security boundary, not a convenience.

The ``persist_*`` functions are exercised with a **fake async database** (no real DB): they must
return True on success and False on failure (observability must never break a response).

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import pytest

import nexus_ai.api.runs as R


class _FakeDB:
    def __init__(self, fail: bool = False):
        self.calls: list[tuple] = []
        self.fail = fail

    async def write(self, sql, *args):
        if self.fail:
            raise RuntimeError("db down")
        self.calls.append((sql, args))


class TestRunLedger:
    def test_ring_evicts_oldest(self):
        led = R.RunLedger(capacity=2)
        led.add({"agent_run_id": "r1", "conversation_id": "c1"})
        led.add({"agent_run_id": "r2", "conversation_id": "c1"})
        led.add({"agent_run_id": "r3", "conversation_id": "c2"})
        # r1 was evicted by capacity
        assert [r["agent_run_id"] for r in led.by_conversation("c1")] == ["r2"]
        assert led.get("r1") is None

    def test_by_conversation_filters(self):
        led = R.RunLedger()
        led.add({"agent_run_id": "r1", "conversation_id": "c1"})
        led.add({"agent_run_id": "r2", "conversation_id": "c2"})
        assert [r["agent_run_id"] for r in led.by_conversation("c2")] == ["r2"]

    def test_get_by_id(self):
        led = R.RunLedger()
        led.add({"agent_run_id": "r1"})
        assert led.get("r1")["agent_run_id"] == "r1"

    def test_clear(self):
        led = R.RunLedger()
        led.add({"agent_run_id": "r1", "conversation_id": "c1"})
        led.clear()
        assert led.by_conversation("c1") == []

    def test_returns_copies_not_references(self):
        led = R.RunLedger()
        led.add({"agent_run_id": "r1", "conversation_id": "c1"})
        out = led.by_conversation("c1")
        out[0]["agent_run_id"] = "tampered"
        assert led.get("r1") is not None  # ledger entry untouched


class TestWriteGuard:
    def test_allowed_tables(self):
        assert R.AI_WRITE_ALLOWED_TABLES == frozenset(
            {"agent_runs", "llm_calls", "events", "feedback_events", "recommendation_sets"}
        )

    def test_ai_owned_tables_allowed(self):
        R._check_table("agent_runs")
        R._check_table("events")
        R._check_table("llm_calls")

    @pytest.mark.parametrize("table", ["orders", "conversations", "messages", "carts"])
    def test_commerce_and_dialogue_tables_refused(self, table):
        # D20: commerce/dialogue writes belong to the platform side, never the AI HTTP layer
        with pytest.raises(RuntimeError):
            R._check_table(table)


class TestRequestContext:
    def test_default_is_empty(self):
        assert R.current_request_id() == ""

    def test_set_then_read(self):
        R.set_request_id("req-123")
        assert R.current_request_id() == "req-123"


class TestNowIso:
    def test_ends_with_z(self):
        assert R.now_iso().endswith("Z")


class TestTimelineRow:
    def test_marks_persisted_without_mutating_source(self):
        row = {"agent_run_id": "r9"}
        out = R.timeline_row(row)
        assert out["persisted"] is True
        assert "persisted" not in row


class TestPersistRun:
    async def test_success_returns_true_and_inserts(self):
        db = _FakeDB()
        run = {"agent_run_id": "11111111-1111-1111-1111-111111111111",
               "tenant_id": "22222222-2222-2222-2222-222222222222", "agent": "search"}
        assert await R.persist_run(db, run) is True
        assert "INSERT INTO agent_runs" in db.calls[0][0]

    async def test_failure_is_swallowed(self):
        # observability must never break a response (§8 / best-effort)
        db = _FakeDB(fail=True)
        run = {"agent_run_id": "11111111-1111-1111-1111-111111111111"}
        assert await R.persist_run(db, run) is False

    async def test_search_event_adds_second_insert(self):
        db = _FakeDB()
        run = {"agent_run_id": "11111111-1111-1111-1111-111111111111",
               "tenant_id": "22222222-2222-2222-2222-222222222222"}
        assert await R.persist_run(
            db, run, search_event={"tenant_id": "22222222-2222-2222-2222-222222222222"}
        ) is True
        assert len(db.calls) == 2
        assert "INSERT INTO events" in db.calls[1][0]


class TestPersistEvent:
    async def test_success(self):
        db = _FakeDB()
        assert await R.persist_event(
            db, {"tenant_id": "22222222-2222-2222-2222-222222222222", "name": "search"}
        ) is True
        assert "INSERT INTO events" in db.calls[0][0]

    async def test_failure_is_swallowed(self):
        assert await R.persist_event(_FakeDB(fail=True), {"tenant_id": "x"}) is False


class TestPersistFeedbackAndSets:
    async def test_feedback_success(self):
        db = _FakeDB()
        ok = await R.persist_feedback(db, {
            "tenant_id": "t", "user_id": "u", "subject_type": "merchant",
            "subject_id": "s", "signal": "click",
        })
        assert ok is True
        assert "INSERT INTO feedback_events" in db.calls[0][0]

    async def test_recommendation_set_success(self):
        db = _FakeDB()
        ok = await R.persist_recommendation_set(
            db, set_id="s1", tenant_id="t", user_id=None, conversation_id=None,
            query="q", intent=None, strategy="s", items=[], latency_ms=5,
        )
        assert ok is True
        assert "INSERT INTO recommendation_sets" in db.calls[0][0]
