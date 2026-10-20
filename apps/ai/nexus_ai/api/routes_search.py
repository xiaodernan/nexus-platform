"""`POST /ai/v1/search` — the deterministic hybrid search and §105 fallback target.

Zero LLM calls (same discipline as `search.service.search`): rule NLU floor + SQL +
ranking. When the SSE stream errors, the client falls back here, so this endpoint must
answer even when every model provider is down — which it does, because it never needs
one. `ai_unavailable` from the model layer must never break it (§1 failure ladder).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.api.pipeline import run_search, validate_intent
from nexus_ai.contract import SearchRequest
from nexus_ai.nlu.understand import extract_intent_dict

log = logging.getLogger("nexus_ai.api.routes_search")

router = APIRouter()


@router.post("/ai/v1/search")
async def search_endpoint(request: Request, body: SearchRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    run_id = runs.new_id()
    intent = body.intent
    if intent is None and body.query:
        # deterministic-only: rule NLU, never the model layer (§105 fallback stays alive)
        intent = validate_intent(extract_intent_dict(
            body.query, {"locale": body.locale,
                         **({"geo": body.geo.model_dump()} if body.geo else {})}))
    try:
        pack = await run_search(
            deps, intent, query=body.query or "", geo=body.geo,
            filters=body.filters, now=body.now, limit=max(1, min(body.limit, 50)),
            locale=body.locale, user_id=body.user_id)
    except Exception as exc:
        log.exception("deterministic search failed")
        return JSONResponse(
            {"error": {"code": "ai_unavailable",
                       "message": f"search backend unavailable: {exc}",
                       "details": {}, "request_id": runs.current_request_id() or None}},
            status_code=503)

    response = pack.response
    data = response.model_dump(mode="json")
    data["agent_run_id"] = run_id
    data["degraded"] = bool(pack.degraded)
    data["intent"] = intent.model_dump(mode="json") if intent else None

    _record(deps, run_id=run_id, body=body, intent=intent, pack=pack)
    headers = {"x-nexus-degraded": "true" if data["degraded"] else "false"}
    return JSONResponse(data, headers=headers)


def _record(deps: Deps, *, run_id: str, body: SearchRequest, intent: Any,
            pack: Any) -> None:
    run = {
        "agent_run_id": run_id, "agent": "search", "status": "succeeded",
        "provider": "none", "model": None,  # zero-LLM path, reported truthfully
        "conversation_id": None, "user_id": str(body.user_id) if body.user_id else None,
        "tenant_id": deps.tenant_id(),
        "input_summary": (body.query or "")[:500] or None,
        "output_summary": f"{len(pack.items)} items",
        "plan": {"steps": ["intent_rules", "search_merchants"]},
        "tool_calls": [{"tool": "search_merchants", "ok": True,
                        "ms": int(pack.response.took_ms)}],
        "fact_ids": pack_response_ids(pack), "latency_ms": int(pack.response.took_ms),
        "cost_usd": 0.0, "fallback_used": None, "error": None,
        "started_at": None, "finished_at": None, "degraded": bool(pack.degraded),
    }
    deps.ledger.add({**run, "persisted": False})
    db = deps.database()
    if db is None:
        return
    event = {
        "event_id": runs.new_id(), "name": "search", "tenant_id": deps.tenant_id(),
        "actor_type": "user" if body.user_id else "anonymous",
        "actor_id": str(body.user_id) if body.user_id else None,
        "session_id": body.session_id,
        "properties": {"query": (body.query or "")[:200],
                       "result_count": len(pack.items), "degraded": bool(pack.degraded),
                       "streamed": False},
        "context": {"locale": body.locale},
    }

    async def _persist() -> None:
        await runs.persist_run(db, run, search_event=event)

    try:
        import asyncio

        task = asyncio.create_task(_persist())
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    except RuntimeError:  # pragma: no cover
        log.debug("no event loop for agent_runs insert")


def pack_response_ids(pack: Any) -> list[str]:
    from nexus_ai.api.pipeline import card_citations

    return card_citations(pack.items)
