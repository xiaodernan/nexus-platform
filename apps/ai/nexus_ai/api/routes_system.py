"""System + telemetry endpoints — `GET /ai/v1/health`, `GET /ai/v1/tools`,
`POST /ai/v1/feedback` (§7).

Health never 5xx's: an unhealthy dependency is *reported*, not raised, so orchestrators
and the §105 ladder can see the real mode (mock vs live, DB up vs down) instead of a
misleading non-2xx. `/ai/v1/tools` is an honest manifest — the canonical
`AGENT_CONTRACT §3` tool names with a `registry_status` flag — because the dispatch
registry (`tools/registry.py`) is not part of this HTTP layer yet; advertising it as live
would be a fabrication. `/ai/v1/feedback` writes only the AI-owned `feedback_events`
table and, offline, records nothing and says so.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.deps import Deps
from nexus_ai.contract import FeedbackRequest, FeedbackResponse

log = logging.getLogger("nexus_ai.api.routes_system")

router = APIRouter()

SERVICE_VERSION = "0.1.0"

#: AGENT_CONTRACT §3 canonical tool names — implement exactly these, never bypass.
CANONICAL_TOOLS: tuple[str, ...] = (
    "search_merchants", "search_products", "search_services", "search_reviews",
    "search_location", "get_business_hours", "get_price", "get_inventory",
    "get_availability", "create_reservation", "create_cart", "update_cart",
    "checkout", "get_order_status", "search_web", "retrieve_merchant_documents",
    "analyze_reviews", "get_user_preferences", "set_user_preference",
    "summarize_reviews", "compare_entities", "draft_campaign", "draft_seo_page",
    "record_event",
)

#: read-only tools this HTTP layer already answers *through its endpoints*
#: (still `implemented: false` for dispatch purposes — there is no registry yet).
_DATA_PATH_TOOLS = frozenset({
    "search_merchants", "search_products", "search_services", "get_business_hours",
    "get_price", "retrieve_merchant_documents", "summarize_reviews", "compare_entities",
    "record_event",
})


# --------------------------------------------------------------------------- health
@router.get("/ai/v1/health")
async def health(request: Request):
    deps: Deps = request.app.state.deps
    settings = deps.settings
    db = deps.database()
    db_available = False
    db_error: str | None = None
    if db is not None:
        try:
            row = await db.readonly("SELECT 1 AS ok")
            db_available = bool(row and row[0].get("ok") == 1)
        except Exception as exc:  # report it, never raise from health
            db_error = str(exc)

    try:
        adapters = [getattr(a, "name", a.__class__.__name__) for a in deps.router().adapters]
    except Exception as exc:  # pragma: no cover - router build is lazy + safe
        adapters = []
        db_error = db_error or f"router unavailable: {exc}"

    offline = settings.llm_provider == "mock" and settings.embedding_provider == "hashing"
    payload: dict[str, Any] = {
        "status": "ok",
        "service": "nexus-ai",
        "version": SERVICE_VERSION,
        "provider": settings.llm_provider,
        "offline": offline,
        "demo_data": bool(settings.demo_data and db is None),
        "database": {
            "configured": bool(settings.database_url),
            "available": db_available,
            **({"error": db_error} if db_error else {}),
        },
        "embeddings": {
            "provider": settings.embedding_provider,
            "dim": settings.embedding_dim,
        },
        "adapters": adapters,
        "now": runs.now_iso(),
    }
    return JSONResponse(payload)


# --------------------------------------------------------------------------- tools
@router.get("/ai/v1/tools")
async def tools(request: Request):
    """Honest registry manifest: names + permissions, `implemented:false` until the
    dispatch registry (AGENT_CONTRACT §3) ships. Never advertise a capability absent."""
    manifest = []
    for name in CANONICAL_TOOLS:
        manifest.append({
            "name": name,
            "implemented": False,
            "registry_status": "not_built",
            "data_path_via_http": name in _DATA_PATH_TOOLS,
        })
    # D451: the degraded flag travels in the body AND the header (OBSERVABILITY.md §2).
    return degraded_json({
        "tools": manifest,
        "count": len(manifest),
        "registry_status": "not_built",
        "note": ("the tool-dispatch registry (tools/registry.py) is not part of this HTTP "
                 "layer; these are the canonical §3 names with the endpoints that already "
                 "exercise the same read paths, not live dispatchable tools"),
        "degraded": True,
    })


# --------------------------------------------------------------------------- feedback
@router.post("/ai/v1/feedback")
async def feedback(request: Request, body: FeedbackRequest):
    deps: Deps = request.app.state.deps
    # D467: the feedback's answer is built through the contract's model - it had no
    # model at all, so nothing described its shape.
    db = deps.database()
    if db is None:
        # D451: the degraded flag travels in the body AND the header.
        return degraded_json(FeedbackResponse(
            recorded=False, degraded=True,
            reason=("no database connection — feedback is not persisted "
                    "offline; nothing was recorded")).model_dump(mode="json"))
    row = {
        "tenant_id": deps.tenant_id(),
        "user_id": str(body.user_id) if body.user_id else None,
        "subject_type": body.subject_type,
        "subject_id": str(body.subject_id) if body.subject_id else None,
        "signal": body.signal,
        "value": body.value,
        "channel": body.channel,
    }
    ok = await runs.persist_feedback(db, row)
    # D451: the degraded flag travels in the body AND the header.
    return degraded_json(FeedbackResponse(
        recorded=bool(ok), degraded=not ok,
        reason=None if ok else "feedback_events insert failed (see server log)"
    ).model_dump(mode="json"))
