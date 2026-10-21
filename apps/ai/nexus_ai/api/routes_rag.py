"""`POST /ai/v1/rag/retrieve` (§7) and `POST /ai/v1/imports/extract` (§7.0, D20).

RAG retrieval is DB-only: without a pool it honestly returns zero chunks rather than
inventing text. Retrieved chunk text is untrusted content (§51): it is scanned for
instruction-shaped language and the count ships with each chunk as
`injection_signals` — the scan never executes anything it finds (AGENT_CONTRACT §8).

`/imports/extract` is service-to-service: gated by `X-Internal-Token` (constant-time
compare), and **501 when the token is unconfigured — never an open door** (D7, the same
rule the platform applies to its agent-message door). The extractor is deterministic
regex + lexicon, so it runs offline and labels itself degraded.
"""

from __future__ import annotations

import hmac
import logging
import re
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import errors, runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import (
    RagChunk, RagRetrieveRequest, RagRetrieveResponse, _Strict)
from nexus_ai.search import sql as S
from nexus_ai.trust.injection import scan_untrusted

log = logging.getLogger("nexus_ai.api.routes_rag")

router = APIRouter()

VECTOR_FLOOR = S.VECTOR_FLOOR


# --------------------------------------------------------------------------- retrieve
async def retrieve_chunks(database: Any, deps: Deps, *, query: str,
                          merchant_id: str | None, tenant_id: str,
                          top_k: int = 8) -> tuple[list[dict[str, Any]], float]:
    """Hybrid chunk read; returns (rows, best_score). Parameterised SQL only (§52)."""
    embedding: list[float] | None = None
    try:
        embedding = (await deps.embeddings().embed([query]))[0]
    except Exception:  # keyword lane survives alone
        log.info("embedding unavailable, keyword-only retrieval")
    # D418: the same canonical form for the chunk lane - the corpus's chunks are indexed
    # as they are, and the canonical form is the one they are written in.
    from nexus_ai.nlu.canonical import canonical

    q = S.build_chunk_query(tenant_id=tenant_id, merchant_id=merchant_id,
                            text=canonical(query),
                            embedding=embedding, top_k=top_k)
    rows = await database.readonly(q.sql, *q.params, schema=deps.settings.db_search_path)
    # D405: the trigram lane counts, and the CONTAINMENT is the evidence. The trigram
    # similarity of a long chunk against a short query does not separate a real match
    # from noise (measured on the seeded corpus: a real Chinese match scores 0.0063 and a
    # nonsense query scores 0.0093), so it can widen the candidate set but it cannot
    # decide whether a chunk really answers the question. Containment can.
    from nexus_ai.search.tokens import mentions

    for r in rows:
        r["hit"] = mentions(str(r.get("text") or ""), query)
    best = max(
        (float(r.get("kw_score") or 0) + float(r.get("trigram_score") or 0)
         + float(r.get("vec_score") or 0) for r in rows),
        default=0.0)
    return rows, best


@router.post("/ai/v1/rag/retrieve")
async def rag_retrieve(request: Request, body: RagRetrieveRequest):
    deps: Deps = request.app.state.deps
    started = time.perf_counter()
    tenant = str(body.tenant_id or deps.tenant_id())
    rows: list[dict[str, Any]] = []
    db = deps.database()
    note = None
    if db is None:
        note = "no database connection — RAG retrieval has no offline corpus to search"
    else:
        try:
            rows, _best = await retrieve_chunks(
                db, deps, query=body.query,
                merchant_id=str(body.merchant_id) if body.merchant_id else None,
                tenant_id=tenant, top_k=body.top_k)
        except Exception as exc:
            log.exception("chunk retrieval failed")
            return errors.error_response(
                "ai_unavailable", str(exc),
                request_id=runs.current_request_id() or None, status=503)
    chunks = []
    for r in rows:
        # D405: a chunk answers the question when it MENTIONS what was asked. The
        # trigram lane widens the candidate set (a Chinese chunk cannot match the
        # tsvector, and the seeded corpus carries no embedding), and the containment
        # decides. The score alone cannot: the trigram similarity of a long chunk
        # against a short query does not separate a real match from noise, and the
        # absolute floor it was measured against is out of the corpus's scale.
        score = max(float(r.get("kw_score") or 0.0), float(r.get("trigram_score") or 0.0),
                    float(r.get("vec_score") or 0.0))
        if not r.get("hit"):
            continue  # §7: no answer without retrieval — drop what was not asked for
        text = str(r.get("text") or "")
        scan = scan_untrusted(text)
        chunks.append(RagChunk(
            id=_uuid_from(str(r["id"])), text=text, score=round(score, 4),
            document_id=_uuid_from(str(r["document_id"])),
            source_uri=r.get("source_uri"), fact_ids=[],
            section=r.get("section"), injection_signals=len(scan.hits)))
    took_ms = int((time.perf_counter() - started) * 1000)
    # D432: the retrieval is a task (AGENT_CONTRACT §8), so it writes a run - and the
    # chunks it was grounded on are its `retrieval`, not its facts (a chunk id is not a
    # fact id).
    await runs.record_run(deps, {
        "agent_run_id": runs.new_id(), "agent": "retrieval", "status": "succeeded",
        "provider": deps.settings.embedding_provider, "model": None,
        "conversation_id": None, "user_id": None, "tenant_id": deps.tenant_id(),
        "input_summary": (body.query or "")[:500] or None,
        "output_summary": f"{len(chunks)} chunks",
        "plan": {"steps": ["retrieve_merchant_documents"]},
        "tool_calls": [{"tool": "retrieve_merchant_documents", "ok": bool(chunks),
                        "ms": took_ms}],
        "retrieval": [str(c.id) for c in chunks], "fact_ids": [],
        "latency_ms": took_ms, "cost_usd": 0.0, "fallback_used": None, "error": None,
        "started_at": None, "finished_at": None, "degraded": False,
    })
    # D467: the note is the model's field - the route used to patch it onto the dumped
    # model, so the model did not describe the answer.
    payload = RagRetrieveResponse(chunks=chunks, took_ms=took_ms,
                                  provider=deps.settings.embedding_provider,
                                  threshold_applied=True, note=note).model_dump(mode="json")
    return JSONResponse(payload)


def _uuid_from(value: str):
    from uuid import UUID

    try:
        return UUID(value)
    except (ValueError, TypeError):
        import uuid

        return uuid.uuid5(uuid.NAMESPACE_DNS, str(value))


# --------------------------------------------------------------------------- imports
class ImportExtractRequest(_Strict):
    source_type: str
    source_ref: str | None = None
    raw_text: str


_PRICE_RE = re.compile(
    r"(?:HK\$|HKD|港幣|港币|\$)\s*(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)|(\d{1,5}(?:\.\d{1,2})?)\s*(?:蚊|元|hkd)",
    re.IGNORECASE)


def _extract_proposals(raw_text: str) -> list[dict[str, Any]]:
    """Deterministic line-based proposal extraction. Names/prices come ONLY from spans
    of the input (§22: a human reviews every proposal before publish)."""
    from nexus_ai.nlu.lexicon import match_category

    proposals: list[dict[str, Any]] = []
    offset = 0
    for line in (raw_text or "").splitlines():
        start = offset
        offset += len(line) + 1
        stripped = line.strip()
        if not stripped or len(stripped) < 2:
            continue
        price: float | None = None
        m = _PRICE_RE.search(stripped)
        if m:
            raw = (m.group(1) or m.group(2) or "").replace(",", "")
            try:
                price = float(raw)
            except ValueError:
                price = None
        name_part = stripped.split("（")[0].split("(")[0]
        name = re.sub(_PRICE_RE, "", name_part).strip(" -–—:：,，、/|｜")
        if not name:
            continue
        hit = match_category(stripped)
        category = hit[0] if hit else None
        confidence = 0.4
        if len(name) >= 2:
            confidence += 0.2
        if price is not None:
            confidence += 0.2
        if category:
            confidence += 0.15
        item: dict[str, Any] = {
            "kind": "product",
            "name": name[:120],
            "price": (f"{price:.2f}" if price is not None else None),
            "currency": "HKD" if price is not None else None,
            "category": category,
            "confidence": round(min(confidence, 0.95), 2),
            "source_span": [start, start + len(line)],
        }
        proposals.append(item)
    return proposals[:100]


@router.post("/ai/v1/imports/extract", include_in_schema=False)
async def imports_extract(request: Request, body: ImportExtractRequest):
    """D442: the service-to-service door is ABSENT from the public OpenAPI document.

    API_CONTRACT §7.0: "These paths exist only between our own services. The BFF must not
    proxy them, they are absent from the public OpenAPI document, and a request that
    arrives from an edge is rejected for missing the shared secret."

    The path was in the OpenAPI document - so a client that reads the document could
    discover the door and call it. The secret still stands (D7: unconfigured is a closed
    door), but the document was telling the world where the door is.
    """
    deps: Deps = request.app.state.deps
    token = deps.settings.internal_token
    if not token:
        # D7: unconfigured secret is a closed door, not an open one.
        return errors.error_response(
            "ai_unavailable",
            "NEXUS_AI_INTERNAL_TOKEN is not configured — "
            "the service-to-service surface stays closed (D7)",
            request_id=runs.current_request_id() or None, status=501)
    given = request.headers.get("x-internal-token", "")
    if not hmac.compare_digest(given, token):
        return errors.error_response(
            "unauthorized", "invalid internal token",
            request_id=runs.current_request_id() or None, status=401)
    # raw_text is untrusted (§51): scanned, counted, never executed — it only becomes data
    scan = scan_untrusted(body.raw_text)
    proposals = _extract_proposals(body.raw_text)
    return JSONResponse({
        "proposals": proposals,
        "extractor": "heuristic-v1",
        "degraded": True,  # rule-based extraction; a human reviews every proposal (§22)
        "injection_signals": len(scan.hits),
    })
