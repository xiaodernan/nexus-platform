"""`GET /ai/v1/conversations/{id}` — the D13 agent-run timeline for one conversation.

The dialogue objects themselves (conversations / messages / handoffs) belong to the
platform door (D20): the AI service has no write path to them and, offline, may not even
read them. What it *can* serve is its own observability — the `agent_runs` rows it
recorded for a session — so a client can rebuild "what the agent did, in order, and which
facts it used" without any commerce write path being touched.

Offline (no pool, CI, demo) it answers from the bounded in-process `RunLedger`, clearly
flagged `persisted: false` + `degraded: true`; a live DB read merges in any runs recorded
this process but not yet visible in the table. The read is parameterised and read-only.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import errors, runs
from nexus_ai.contract import ConversationView
from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.deps import Deps

log = logging.getLogger("nexus_ai.api.routes_conversations")

router = APIRouter()


def _jsonable(v: Any) -> Any:
    """Timestamps/UUIDs out of DB rows to JSON scalars (JSONResponse won't encode them)."""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def _bad_request(message: str) -> JSONResponse:
    # D438: the envelope comes from the contract's own shape.
    return errors.error_response("validation_error", message,
                                  request_id=runs.current_request_id() or None,
                                  status=422)


@router.get("/ai/v1/conversations/{conversation_id}")
async def conversation_timeline(request: Request, conversation_id: str):
    deps: Deps = request.app.state.deps
    try:
        cid = str(UUID(conversation_id))
    except (ValueError, TypeError, AttributeError):
        return _bad_request("conversation_id must be a UUID")

    timeline: list[dict[str, Any]] = []
    db = deps.database()
    degraded = True
    reason: str | None = "no database connection — serving the in-process run ledger only"

    if db is not None:
        try:
            rows = await db.readonly(runs.CONVERSATION_RUNS_SQL, cid,
                                     schema=deps.settings.db_search_path)
            timeline = [runs.timeline_row({k: _jsonable(v) for k, v in r.items()})
                        for r in (rows or [])]
            degraded = False
            reason = None
        except Exception as exc:  # a read failure degrades to the ledger, never a 500
            log.warning("conversation timeline read failed: %s", exc)
            timeline = []
            reason = f"timeline read unavailable: {exc}"

    # fold in this process's runs (offline demo, or live runs still in flight)
    seen = {str(r.get("agent_run_id")) for r in timeline}
    for r in deps.ledger.by_conversation(cid):
        if str(r.get("agent_run_id")) not in seen:
            timeline.append({k: _jsonable(v) for k, v in r.items()})
            seen.add(str(r.get("agent_run_id")))

    timeline.sort(key=lambda r: str(r.get("started_at") or ""))

    # D469: the view's shape comes from the contract's model - the route used to spell the
    # fields out in a dict, and the shape was in no model at all.
    payload = ConversationView(
        conversation_id=cid, agent_runs=timeline, count=len(timeline),
        degraded=degraded, reason=reason)
    # D451: the degraded flag travels in the body AND the header (OBSERVABILITY.md §2).
    return degraded_json(payload.model_dump(mode="json"))
