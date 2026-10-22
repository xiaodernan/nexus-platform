"""Request-scoped ids + the in-process `agent_runs` ledger (AGENT_CONTRACT §8 observability).

Two paths, both AI-owned tables only:

* every run is kept in a small in-memory ring so `GET /ai/v1/conversations/{id}` can
  answer the timeline offline (CI, demo) — those entries are flagged `persisted: false`;
* when a pool exists the run is INSERTed into `agent_runs` (read-write for `nexus_ai`,
  `infra/postgres/init/00_roles.sql`) and a `search` row into `events` — **never** with
  `RETURNING` (D19 measured: INSERT-but-no-SELECT), and **never** into
  conversations/messages/carts/orders: D20 keeps every commerce/dialogue write on the
  platform side. Persistence is best-effort and its failure can never break a response.
"""

from __future__ import annotations

import contextvars
import json
import logging
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

log = logging.getLogger("nexus_ai.api.runs")

_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")


def current_request_id() -> str:
    return _request_id.get()


def set_request_id(value: str):
    return _request_id.set(value)


def new_id() -> str:
    """Seam for tests — never call `uuid4` inline so streams can be made deterministic."""
    return str(uuid4())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- ledger
def stamp_run(run: dict[str, Any]) -> dict[str, Any]:
    """D440: a run that says when it started and never when it finished is half a run.

    The `agent_runs` row carries `started_at` and `finished_at`, and API_CONTRACT §7's
    conversation-timeline row lists both - but every one of the 446 runs on the seeded
    plane had `finished_at` NULL, because no caller ever passed one and the column has no
    default. The write IS the finish, so the recorder stamps it, and it back-solves the
    start from the measured latency so the pair is internally consistent.
    """
    stamped = dict(run)
    if not stamped.get("finished_at"):
        finished = datetime.now(timezone.utc)
        stamped["finished_at"] = finished.isoformat().replace("+00:00", "Z")
        if not stamped.get("started_at"):
            latency = int(stamped.get("latency_ms") or 0)
            started = finished - timedelta(milliseconds=latency)
            stamped["started_at"] = started.isoformat().replace("+00:00", "Z")
    return stamped


class RunLedger:
    """Bounded in-process mirror of recent `agent_runs`, keyed by conversation."""

    def __init__(self, capacity: int = 256) -> None:
        self._runs: deque[dict[str, Any]] = deque(maxlen=capacity)

    def add(self, run: dict[str, Any]) -> None:
        self._runs.append(stamp_run(run))

    def get_all(self) -> list[dict[str, Any]]:
        """Every run in the ring, oldest first (D432: the census reads this)."""
        return [dict(r) for r in self._runs]

    def by_conversation(self, conversation_id: Any) -> list[dict[str, Any]]:
        cid = str(conversation_id)
        return [dict(r) for r in self._runs if str(r.get("conversation_id") or "") == cid]

    def get(self, agent_run_id: Any) -> dict[str, Any] | None:
        for r in self._runs:
            if str(r.get("agent_run_id")) == str(agent_run_id):
                return dict(r)
        return None

    def clear(self) -> None:
        self._runs.clear()


#: §0/API_CONTRACT: these are the only tables the AI service's HTTP layer may write.
AI_WRITE_ALLOWED_TABLES = frozenset(
    {"agent_runs", "llm_calls", "events", "feedback_events", "recommendation_sets"})


def _check_table(table: str) -> None:
    if table not in AI_WRITE_ALLOWED_TABLES:
        raise RuntimeError(
            f"refusing to write {table!r} from the AI HTTP layer — not in the AI-owned "
            "grant set (API_CONTRACT §0, D19/D20)")


# D450: the uuid[] SQL builder that used to stand here is gone - the writer binds the
# fact ids as one string and lets Postgres cast them.


async def record_run(deps: Any, run: dict[str, Any],
                    llm_records: Any = None) -> None:
    """Write one `agent_runs` row: the in-process ledger first, the table best-effort.

    D432: three surfaces wrote no run at all - the retrieval, the intent extraction and
    the recommendation - and the recommendation's response handed the caller an
    `agent_run_id` that resolved to nothing. One recorder, so the shape of a run is
    written down ONCE (AGENT_CONTRACT §8: every task writes one).

    D448: the cost ledger's rows travel SEPARATELY, not inside the run: the run row is
    served to the browser (the timeline endpoint) and it has to stay serialisable.
    """
    deps.ledger.add({**run, "persisted": False})
    db = deps.database()
    if db is None:
        return
    try:
        await persist_run(db, run, llm_records=llm_records)
    except Exception:  # pragma: no cover - a persistence failure never breaks a response
        log.warning("agent_runs insert failed (continuing degraded)", exc_info=True)


async def persist_run(database: Any, run: dict[str, Any], *,
                      search_event: dict[str, Any] | None = None,
                      llm_records: Any = None) -> bool:
    """Best-effort INSERT of one agent_run (+ optional `events` search row)."""
    _check_table("agent_runs")
    fact_ids = [str(f) for f in (run.get("fact_ids") or []) if f]
    sql = """
INSERT INTO agent_runs (
  id, tenant_id, user_id, merchant_id, conversation_id, agent, model, provider, status,
  plan, input_summary, output_summary, tool_calls, retrieval, fact_ids,
  prompt_tokens, completion_tokens, cost_usd, latency_ms, fallback_used,
  started_at, finished_at, task_id, parent_run_id, error)
VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9,
  $10::jsonb, $11, $12, $13::jsonb, $14::jsonb,
  COALESCE(string_to_array($15, ','), '{}')::uuid[],
  $16, $17, $18, $19, $20,
  -- callers time the run off a monotonic clock and pass `started_at=None`; `started_at` is
  -- NOT NULL, so an explicit NULL overrode the column default and every insert was rejected.
  -- Back-solving it from the measured latency keeps the ledger honest instead of lossy.
  COALESCE($21::timestamptz, now() - make_interval(secs => $19::int / 1000.0)),
  -- D440: the write IS the finish. `finished_at` had no default and no caller ever passed
  -- one, so every run on the plane carried a NULL end - and the documented timeline shape
  -- lists it.
  COALESCE($22::timestamptz, now()),
  -- D443: the three columns the INSERT used to DROP. `error` and `parent_run_id` are named
  -- by the contract (API_CONTRACT §7's timeline row, DATABASE.md §3.12, AGENT_CONTRACT §8),
  -- so a failed run could not say why it failed and a sub-agent run could not link to its
  -- parent - the writer had no way to say either.
  $23, $24::uuid, $25
)
"""

    def _uuid_or_none(v: Any) -> str | None:
        return str(v) if v else None

    args = (
        run["agent_run_id"], _uuid_or_none(run.get("tenant_id")),
        _uuid_or_none(run.get("user_id")), _uuid_or_none(run.get("merchant_id")),
        _uuid_or_none(run.get("conversation_id")), run.get("agent") or "search",
        run.get("model"), run.get("provider"), run.get("status") or "succeeded",
        json.dumps(run.get("plan") or {}, ensure_ascii=False),
        run.get("input_summary"), run.get("output_summary"),
        json.dumps(run.get("tool_calls") or [], ensure_ascii=False),
        json.dumps(run.get("retrieval") or [], ensure_ascii=False),
        ",".join(fact_ids),
        int(run.get("prompt_tokens") or 0), int(run.get("completion_tokens") or 0),
        float(run.get("cost_usd") or 0.0), int(run.get("latency_ms") or 0),
        run.get("fallback_used"), run.get("started_at"), run.get("finished_at"),
        run.get("task_id"), _uuid_or_none(run.get("parent_run_id")), run.get("error"),
    )
    try:
        await database.write(sql, *args)
    except Exception:  # pragma: no cover - observability must never break a response
        log.warning("agent_runs insert failed (continuing degraded)", exc_info=True)
        return False
    # D448: the cost ledger's rows go in with the run, and AFTER it - `llm_calls`
    # refers to `agent_runs(id)`, so a ledger row written before the run is rejected by
    # the foreign key. One recorder, one order.
    await write_llm_calls(database, llm_records, run["agent_run_id"])
    if search_event is not None:
        await persist_event(database, search_event)
    return True


async def persist_llm_call(database: Any, row: dict[str, Any]) -> bool:
    """`llm_calls` is the cost ledger (§160): one row per model call.

    D437: the table was AI-owned and empty. The router built the exact row for it
    (`RoutedCall.as_llm_call_row`) and nothing ever called it, so the product measured
    every model call and then threw the measurement away.
    """
    _check_table("llm_calls")
    sql = """
    INSERT INTO llm_calls (agent_run_id, provider, model, purpose, prompt_tokens,
                           completion_tokens, cost_usd, latency_ms, status, cache_hit)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    """
    try:
        await database.write(
            sql,
            str(row["agent_run_id"]) if row.get("agent_run_id") else None,
            str(row.get("provider") or "none"),
            str(row.get("model") or "unknown"),
            str(row.get("purpose") or "generate"),
            int(row.get("prompt_tokens") or 0),
            int(row.get("completion_tokens") or 0),
            float(row.get("cost_usd") or 0.0),
            int(row.get("latency_ms") or 0),
            str(row.get("status") or "ok"),
            bool(row.get("cache_hit") or False),
        )
    except Exception:  # pragma: no cover - a ledger write never breaks a response
        log.warning("llm_calls insert failed (continuing degraded)", exc_info=True)
        return False
    return True


async def write_llm_calls(database: Any, records: Any, agent_run_id: Any = None) -> None:
    """Write one `llm_calls` row per model call the router made (D437).

    The rows are written AFTER the run they belong to: `llm_calls.agent_run_id` refers to
    `agent_runs(id)`, so a ledger row written first is rejected by the foreign key. That is
    why this is called from `persist_run` and not from the caller - one recorder, one order.
    """
    for record in list(records or []):
        try:
            await persist_llm_call(database, record.as_llm_call_row(agent_run_id))
        except Exception:  # pragma: no cover - never fatal
            log.warning("llm_calls insert failed (continuing degraded)", exc_info=True)


async def persist_event(database: Any, event: dict[str, Any]) -> bool:
    """`events` is INSERT-only (D19): no RETURNING, no SELECT, never fatal."""
    _check_table("events")
    sql = """
INSERT INTO events (event_id, tenant_id, actor_type, actor_id, name, subject_type,
                    subject_id, session_id, conversation_id, properties, context)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8, $9::uuid,
        $10::jsonb, $11::jsonb)
"""
    try:
        await database.write(
            sql,
            event.get("event_id") or new_id(),
            str(event["tenant_id"]) if event.get("tenant_id") else None,
            event.get("actor_type") or "anonymous",
            str(event["actor_id"]) if event.get("actor_id") else None,
            event.get("name") or "search",
            event.get("subject_type"),
            str(event["subject_id"]) if event.get("subject_id") else None,
            event.get("session_id"),
            str(event["conversation_id"]) if event.get("conversation_id") else None,
            json.dumps(event.get("properties") or {}, ensure_ascii=False),
            json.dumps(event.get("context") or {}, ensure_ascii=False),
        )
    except Exception:  # pragma: no cover
        log.warning("events insert failed (continuing degraded)", exc_info=True)
        return False
    return True


async def persist_feedback(database: Any, fb: dict[str, Any]) -> bool:
    _check_table("feedback_events")
    sql = """
INSERT INTO feedback_events (tenant_id, user_id, subject_type, subject_id, signal, value,
                             channel)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::jsonb, $7)
"""
    try:
        await database.write(
            sql,
            str(fb["tenant_id"]) if fb.get("tenant_id") else None,
            str(fb["user_id"]) if fb.get("user_id") else None,
            fb["subject_type"],
            str(fb["subject_id"]) if fb.get("subject_id") else None,
            fb["signal"],
            json.dumps(fb.get("value") or {}, ensure_ascii=False),
            fb.get("channel") or "web",
        )
    except Exception:  # pragma: no cover
        log.warning("feedback insert failed", exc_info=True)
        return False
    return True


async def persist_recommendation_set(database: Any, *, set_id: Any, tenant_id: Any,
                                     user_id: Any, conversation_id: Any, query: str | None,
                                     intent: dict[str, Any] | None, strategy: str,
                                     items: list[dict[str, Any]],
                                     latency_ms: int) -> bool:
    _check_table("recommendation_sets")
    sql = """
INSERT INTO recommendation_sets (id, tenant_id, user_id, conversation_id, query, intent,
                                 strategy, items, latency_ms)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7, $8::jsonb, $9)
"""
    try:
        await database.write(
            sql, str(set_id), str(tenant_id),
            str(user_id) if user_id else None,
            str(conversation_id) if conversation_id else None, query,
            json.dumps(intent or {}, ensure_ascii=False), strategy,
            json.dumps(items, ensure_ascii=False), int(latency_ms))
    except Exception:  # pragma: no cover
        log.warning("recommendation_sets insert failed", exc_info=True)
        return False
    return True


#: SQL for the D13 conversation timeline — parameterised, read-only.
CONVERSATION_RUNS_SQL = """
SELECT id::text AS agent_run_id, tenant_id::text, user_id::text, merchant_id::text,
       conversation_id::text, agent, model, provider, status, plan, input_summary,
       output_summary, tool_calls, retrieval,
       array(select i::text from unnest(fact_ids) i) AS fact_ids,
       prompt_tokens, completion_tokens, cost_usd::float8 AS cost_usd, latency_ms,
       error, fallback_used, started_at, finished_at, parent_run_id::text
FROM agent_runs
WHERE conversation_id = $1::uuid
ORDER BY started_at ASC
LIMIT 100
"""


def timeline_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["persisted"] = True
    return out
