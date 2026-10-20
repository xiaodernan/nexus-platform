"""SSE endpoints — `POST /ai/v1/search/stream` (D13 canonical) and
`POST /ai/v1/merchant-agent/chat` (§7, merchant-KB-grounded, handoff-first)."""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Optional
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import Field, field_validator

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.api.pipeline import MAX_QUERY_LENGTH
from nexus_ai.api.sse import CANONICAL_STREAM_EVENTS, sse_bytes, sse_frame
from nexus_ai.api.stream import search_stream_events
from nexus_ai.contract import MerchantAgentRequest, _Strict
from nexus_ai.models.mock import SUMMARY_TEMPLATES

log = logging.getLogger("nexus_ai.api.routes_stream")

router = APIRouter()

STREAM_HEADERS = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
}


class StreamSearchRequest(_Strict):
    """Body shape the web BFF forwards verbatim
    (`apps/web/app/api/nexus/ai/stream/route.ts`)."""

    query: str
    conversation_id: Optional[UUID] = None
    previous_intent: Optional[dict[str, Any]] = None
    context: dict[str, Any] = Field(default_factory=dict)
    limit: int = 8

    @field_validator("query")
    @classmethod
    def _check_query(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("query is required")
        if len(v) > MAX_QUERY_LENGTH:
            raise ValueError(f"query must be at most {MAX_QUERY_LENGTH} characters")
        return v


def _deps(request: Request) -> Deps:
    return request.app.state.deps


@router.post("/ai/v1/search/stream")
async def search_stream(request: Request, body: StreamSearchRequest) -> StreamingResponse:
    deps = _deps(request)
    events = search_stream_events(
        query=body.query, deps=deps, context=body.context,
        conversation_id=str(body.conversation_id) if body.conversation_id else None,
        previous_intent=body.previous_intent, limit=max(1, min(body.limit, 50)),
        request_id=runs.current_request_id())
    return StreamingResponse(sse_bytes(events), headers=dict(STREAM_HEADERS),
                             media_type="text/event-stream; charset=utf-8")


# --------------------------------------------------------------- merchant agent chat
_CHAT_STAGE_TEXT = {
    "zh-HK": {"reading": "查閱商戶知識庫…", "answering": "整理答復…"},
    "zh-CN": {"reading": "查阅商户知识库…", "answering": "整理答复…"},
    "en": {"reading": "Reading the merchant knowledge base…", "answering": "Composing…"},
}


async def _merchant_agent_events(body: MerchantAgentRequest, deps: Deps,
                                 request_id: str | None) -> AsyncIterator[tuple[str, Any]]:
    """Handoff-first agent (§24-26): answer ONLY from retrieved merchant KB chunks;
    below the confidence floor say so and offer a human — never improvise (§4/§7)."""
    from nexus_ai.models.base import norm_locale

    locale = norm_locale(str(body.context.get("locale") or deps.settings.default_locale))
    t = SUMMARY_TEMPLATES[locale]
    copy = _CHAT_STAGE_TEXT[locale]
    started = runs.now_iso()
    run_id = runs.new_id()
    try:
        yield ("status", {"stage": "understanding", "text": copy["reading"]})
        chunks: list[dict[str, Any]] = []
        score = 0.0
        db = deps.database()
        if db is not None:
            from nexus_ai.api.routes_rag import retrieve_chunks
            chunks, score = await retrieve_chunks(
                db, deps, query=body.message, merchant_id=str(body.merchant_id),
                tenant_id=deps.tenant_id(), top_k=6)
        grounded = bool(chunks) and score >= 0.35
        provider = "mock"
        if grounded:
            yield ("status", {"stage": "summarizing", "text": copy["answering"]})
            from nexus_ai.models.base import LLMRequest
            from nexus_ai.models.router import CostMeter

            meter = CostMeter()
            wrapped, _report = _wrap_for_summary(chunks)
            call = await deps.router().run(LLMRequest(
                task_class="summary",
                payload={"records": wrapped, "locale": locale}), meter=meter)
            provider = call.response.provider
            yield ("summary", {"text": call.response.text,
                               "citations": [c["id"] for c in wrapped][:8]})
        else:
            yield ("summary", {"text": t["none_grounded"] + " " + t["handoff"],
                               "citations": []})
        yield ("done", {"agent_run_id": run_id, "latency_ms": _ms_since(started),
                        "cost_usd": 0.0, "degraded": not grounded,
                        "provider": provider})
    except Exception as exc:  # the same inside-stream error contract as search
        log.exception("merchant-agent stream failed")
        yield ("error", {"code": "internal", "message": str(exc),
                         "request_id": request_id})


def _wrap_for_summary(chunks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], Any]:
    """Chunk text is untrusted (§51): scanned + wrapped, used as data only."""
    from nexus_ai.trust.injection import scan_untrusted

    records = []
    report = None
    for c in chunks:
        scan = scan_untrusted(c.get("text") or "")
        report = scan if report is None else report
        records.append({"title": c.get("section") or c.get("document_id") or "KB",
                        "text": c.get("text") or ""})
    return records, report


def _ms_since(iso: str) -> int:
    from datetime import datetime, timezone

    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:  # pragma: no cover
        return 0
    return max(0, int((datetime.now(timezone.utc) - then).total_seconds() * 1000))


@router.post("/ai/v1/merchant-agent/chat")
async def merchant_agent_chat(request: Request, body: MerchantAgentRequest):
    deps = _deps(request)
    events = _merchant_agent_events(body, deps, runs.current_request_id())
    return StreamingResponse(sse_bytes(events), headers=dict(STREAM_HEADERS),
                             media_type="text/event-stream; charset=utf-8")
