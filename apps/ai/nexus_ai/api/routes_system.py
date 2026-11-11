"""System + telemetry endpoints — `GET /ai/v1/health`, `GET /ai/v1/tools`,
`POST /ai/v1/feedback` (§7).

Health never 5xx's: an unhealthy dependency is *reported*, not raised, so orchestrators
and the §105 ladder can see the real mode (mock vs live, DB up vs down) instead of a
misleading non-2xx. `/ai/v1/tools` is an honest manifest — the canonical
`AGENT_CONTRACT §3` tool names with a `registry_status` flag — because the dispatch
registry (`tools/registry.py`) ships with its pipeline enforced but no tool handlers registered yet; advertising it as live
would be a fabrication. `/ai/v1/feedback` writes only the AI-owned `feedback_events`
table and, offline, records nothing and says so.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.deps import Deps
from nexus_ai.contract import (
    DatabaseHealth, EmbeddingsHealth, FeedbackRequest, FeedbackResponse,
    HealthResponse, ToolManifestEntry, ToolsManifestResponse)
from nexus_ai.tools.names import CANONICAL_TOOL_NAMES

log = logging.getLogger("nexus_ai.api.routes_system")

router = APIRouter()

SERVICE_VERSION = "0.1.0"

#: AGENT_CONTRACT §3 canonical tool names — implement exactly these, never bypass.
#: D496: the list was written out here a second time, and the trust layer's copy of it
#: was missing eight of the names. The names are ONE list now — nexus_ai/tools/names.py.
CANONICAL_TOOLS: tuple[str, ...] = CANONICAL_TOOL_NAMES

#: read-only tools this HTTP layer already answers *through its endpoints*
#: read-only tools the dispatch registry registers today (tools/builtin.py) — the
#: HTTP layer answers them through its endpoints and the manifest reads the live registry.
_DATA_PATH_TOOLS = frozenset({
    "search_merchants", "get_business_hours", "get_price", "get_user_preferences",
    "search_products", "search_services", "search_reviews",
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
    # D473: the answer is built through the contract's model - the route used to write the
    # ten fields out in a dict, so nothing described the health check's shape.
    payload = HealthResponse(
        status="ok",
        service="nexus-ai",
        version=SERVICE_VERSION,
        provider=settings.llm_provider,
        offline=offline,
        demo_data=bool(settings.demo_data and db is None),
        database=DatabaseHealth(
            configured=bool(settings.database_url),
            available=db_available,
            error=db_error or None,
        ),
        embeddings=EmbeddingsHealth(
            provider=settings.embedding_provider,
            dim=settings.embedding_dim,
        ),
        adapters=adapters,
        now=runs.now_iso(),
    )
    return JSONResponse(payload.model_dump(mode="json"))


# --------------------------------------------------------------------------- tools
@router.get("/ai/v1/tools")
async def tools(request: Request):
    """Honest registry manifest. The dispatch registry ships (tools/registry.py +
    builtin.py). `get_business_hours` is registered and dispatchable; the remaining
    canonical §3 names are listed with implemented:false until each ships. The status
    string and the entries both tell the truth; nothing pretends to be reachable that
    is not, and nothing claims live orchestration the process does not hold."""
    # D776: the manifest is built from the registry the process actually holds.
    # A registered tool is advertised as implemented; an unregistered canonical name is
    # advertised as not implemented - nothing pretends to be dispatchable that is not.
    deps: Deps = request.app.state.deps
    registry = deps.tool_registry()
    live_count = sum(1 for name in CANONICAL_TOOLS if registry.spec(name) is not None)
    status = "live" if live_count == len(CANONICAL_TOOLS) else "skeleton"

    manifest = []
    for name in CANONICAL_TOOLS:
        spec = registry.spec(name)
        manifest.append(ToolManifestEntry(
            name=name,
            implemented=spec is not None,
            registry_status=status,
            data_path_via_http=name in _DATA_PATH_TOOLS,
        ))
    # D473: the answer is built through the contract's model (D451: the degraded flag
    # travels in the body AND the header - OBSERVABILITY.md §2).
    return degraded_json(ToolsManifestResponse(
        tools=manifest,
        count=len(manifest),
        registry_status=status,
        note=(
            f"the tool-dispatch registry ships with the §3 pipeline enforced; "
            f"{live_count} of {len(CANONICAL_TOOLS)} canonical read-only tools are "
            f"implemented (get_business_hours, get_price, get_user_preferences, "
            f"search_merchants, search_services, search_products, search_reviews through the live backend path). "
            f"Remaining canonical names are listed but not yet dispatchable; they "
            f"appear with implemented:false."),
        degraded=True,
    ).model_dump(mode="json"))


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
