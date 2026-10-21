"""SSE endpoints — `POST /ai/v1/search/stream` (D13 canonical) and
`POST /ai/v1/merchant-agent/chat` (§7, merchant-KB-grounded, handoff-first)."""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Optional
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import Field, field_validator

from nexus_ai.api import errors, runs
from nexus_ai.api.deps import Deps
from nexus_ai.api.pipeline import MAX_QUERY_LENGTH
from nexus_ai.api.sse import sse_bytes
from nexus_ai.api.stream import search_stream_events
from nexus_ai.contract import (
    MerchantAgentRequest, StreamDoneFrame, StreamStatusFrame, StreamSummaryFrame,
    _Strict)
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
        yield ("status", StreamStatusFrame(
            stage="understanding", text=copy["reading"]).model_dump(mode="json"))
        chunks: list[dict[str, Any]] = []
        db = deps.database()
        if db is not None:
            from nexus_ai.api.routes_rag import retrieve_chunks
            # The retrieval's own score is not the grounding signal (D405), so it is not
            # read here; the containment is.
            chunks, _score = await retrieve_chunks(
                db, deps, query=body.message, merchant_id=str(body.merchant_id),
                tenant_id=deps.tenant_id(), top_k=6)
        # D405: the grounding test is the CONTAINMENT, not an absolute score floor.
        # The floor was 0.35 and the corpus could not reach it: the best retrieval score
        # measured on the seeded plane is 0.09 for a good English match and 0.00 for a
        # Chinese one, so the merchant agent answered EVERY question with "I cannot find
        # that" and a handoff -- for a merchant whose KB plainly contains the answer.
        # The retrieval already returns only chunks that matched (its WHERE clause is the
        # filter), and a chunk that matched because it MENTIONS what was asked is the
        # evidence. A chunk that matched only by trigram noise is not, and the
        # containment test is what tells them apart.
        grounded = any(bool(c.get("hit")) for c in chunks)
        provider = "mock"
        answer_text = ""
        usage: dict[str, Any] = {}
        llm_records: list[Any] = []
        if grounded:
            yield ("status", StreamStatusFrame(
                stage="summarizing", text=copy["answering"]).model_dump(mode="json"))
            from nexus_ai.models.base import LLMRequest
            from nexus_ai.models.router import CostMeter

            meter = CostMeter()
            wrapped, _report = _wrap_for_summary(chunks)
            call = await deps.router().run(LLMRequest(
                task_class="summary",
                payload={"records": wrapped, "locale": locale}), meter=meter)
            # D437: the chat's model call is a row in the cost ledger too - written after
            # the run row, because the ledger row refers to it.
            usage = meter.usage()
            llm_records = list(meter.records)
            provider = call.response.provider
            # D405: the citations are the CHUNKS' ids. `_wrap_for_summary` returns the
            # model payload (title + scanned text) and holds no id, so the grounded branch
            # used to raise `KeyError: 'id'` and the stream answered with an error frame
            # instead of an answer. The branch had never run: the old floor (0.35) was
            # unreachable, so every question took the handoff path and the crash stayed
            # hidden behind a defect that was hiding it.
            answer_text = call.response.text
            yield ("summary", StreamSummaryFrame(
                text=answer_text,
                citations=[str(c.get("id")) for c in chunks if c.get("id")][:8],
            ).model_dump(mode="json"))
        else:
            answer_text = t["none_grounded"] + " " + t["handoff"]
            yield ("summary", StreamSummaryFrame(
                text=answer_text, citations=[]).model_dump(mode="json"))
        yield ("done", StreamDoneFrame(
            agent_run_id=run_id, latency_ms=_ms_since(started),
            cost_usd=float((usage or {}).get("cost_usd") or 0.0),
            degraded=not grounded, provider=provider).model_dump(mode="json"))
        await _record_chat(deps, run_id=run_id, body=body, grounded=grounded,
                          answer=answer_text, citations=[str(c.get("id")) for c in chunks
                                                       if c.get("id")],
                          latency_ms=_ms_since(started), provider=provider,
                          usage=usage, llm_records=llm_records)
    except Exception as exc:  # the same inside-stream error contract as search
        log.exception("merchant-agent stream failed")
        # D444: the failed turn is still a task, and §8 says every task writes a run - the
        # search stream has written its failed run all along, and the chat's error frame
        # was the only trace of a merchant turn that broke. The frame goes out FIRST (the
        # user is not waiting on a ledger write) and the run is recorded after it, exactly
        # as the search stream does.
        # D455: the error frame is built by the one builder, from the contract's own error
        # body, and the code follows the one rule - the search stream says "ai_unavailable"
        # when the model layer or the database is unreachable, and this one said
        # "internal" whatever broke, so the same failure got two codes.
        yield ("error", errors.error_frame(exc, request_id=request_id))
        await _record_chat(deps, run_id=run_id, body=body, grounded=False, answer="",
                           citations=[], latency_ms=_ms_since(started), provider="none",
                           status="failed", error=str(exc))


async def _record_chat(deps: Any, *, run_id: str, body: Any, grounded: bool, answer: str,
                 citations: list[str], latency_ms: int, provider: str,
                 usage: dict[str, Any] | None = None,
                 llm_records: list[Any] | None = None,
                 status: str | None = None, error: str | None = None) -> None:
    """Write the chat's `agent_runs` row (AGENT_CONTRACT §8: every task writes one).

    D431: the chat wrote NONE, so its turns were invisible to the conversation timeline
    and to the observability surface - and the request REQUIRES a conversation_id, so
    the caller had already paid for the linkage. The run carries the conversation, the
    merchant, the message, the answer and the chunks the answer was grounded on (the
    `retrieval` column, not `fact_ids`: a chunk id is not a fact id).

    D444: a chat that FAILED wrote no run either - the search stream has written its
    failed run since D434's era, and the chat's error frame was the only trace of a
    merchant turn that broke. A failed task is still a task.
    """
    from nexus_ai.api import runs

    usage = usage or {}
    run = {
        "agent_run_id": run_id, "agent": "merchant_agent",
        "status": status or ("succeeded" if grounded else "degraded"),
        "provider": provider, "model": None,
        "conversation_id": str(body.conversation_id) if body.conversation_id else None,
        "merchant_id": str(body.merchant_id) if body.merchant_id else None,
        "user_id": None,
        "tenant_id": deps.tenant_id(),
        "input_summary": (body.message or "")[:500] or None,
        "output_summary": (answer or "")[:500] or None,
        "plan": {"steps": ["retrieve_merchant_documents", "summarize"]},
        "tool_calls": [{"tool": "retrieve_merchant_documents", "ok": bool(citations),
                        "ms": latency_ms}],
        "retrieval": citations,
        "fact_ids": [],
        "latency_ms": latency_ms,
        # D437: the tokens and the cost the model layer measured.
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "cost_usd": float(usage.get("cost_usd") or 0.0),
        "fallback_used": None if grounded else "no_grounded_chunks",
        # D443: the writer now writes this column, so a failed run can say why.
        "error": error, "started_at": None, "finished_at": None,
        "degraded": not grounded,
    }
    deps.ledger.add({**run, "persisted": False})
    db = deps.database()
    if db is None:
        return
    # D448: the cost ledger's rows travel separately, and go in with the run - the
    # ledger row refers to it.
    await runs.persist_run(db, run, llm_records=llm_records or [])


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
