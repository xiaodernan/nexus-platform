"""`POST /ai/v1/handbook/ask` — the live model phrases the manual's answer, grounded.

The web product embeds a deterministic lexical retriever over the in-product manual
(`apps/web/src/lib/manual-rag.ts`). That one is honest, offline and always available; it
never answers a question the manual does not contain, but it also cannot _phrase_ its
answer — it can only quote the section back. Mandate §九/§四 asks the model to actually do
work in the flow. This is the lane that does it, with the manual as the only source of
truth and the retrieval path as the floor:

- input is the top sections the retrieval lane already believes are relevant;
- the system prompt forbids answering from outside them, forbids URLs, forbids inventing
  features/labels, forbids filling gaps with guesses;
- the reply is parsed strictly: `citations` must reference ids that were provided; the
  `answer` may not carry URLs; `confidence` must be one of `low|medium|high`;
  ANY violation, timeout, parse failure or empty answer — the response is `degraded` with
  an empty `answer` and the web lane falls back to the deterministic phrasing verbatim.
- nothing here fetches or indexes anything: the manual is THE corpus, always.

Budget: task_class `summary` (mid tier), temperature 0, at most 1 reason-class call.
"""
from __future__ import annotations

import json
import logging
import re
import time

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import HandbookAskRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for

log = logging.getLogger("nexus_ai.api.routes_handbook")

router = APIRouter()

_MAX_SECTION_BODY = 2400

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)

_SYSTEM = """You are the NEXUS manual's reader. You will be given the manual's own sections and ONE question written in its original language.
Answer in the SAME language as the question. Hard constraints:
- Use ONLY the provided sections. Never invent a feature, path, rule or label that is not there.
- If the manual does not contain the answer, reply with JSON: {"answer": "<one sentence naming what the manual does not say, in its own vocabulary>", "citations": [], "confidence": "low"}. Never fill the gap with a guess.
- Otherwise reply with JSON: {"answer": "<short plain-prose answer in the question's language, the manual's own facts, at most one section cited inline in [square brackets]>", "citations": [{"id": "<id of the section you used>", "title": "<the section's own title>"}], "confidence": "high|medium|low"}.
- Every citation id must exist among the provided sections. Output JSON only. No URLs, no markdown links, no code fences, no bold, no tables.
- The answer must be under 360 characters.
"""


def _degraded(reason: str) -> JSONResponse:
    """§105 fail-closed: an empty answer tells the web lane to use its retrieval phrasing."""
    return JSONResponse(
        status_code=200,
        content={
            "answer": "",
            "citations": [],
            "confidence": "low",
            "degraded": True,
            "reason": reason,
        },
    )


def _citation_ids(citations: Any) -> list[str]:
    out: list[str] = []
    for item in citations if isinstance(citations, list) else []:
        if isinstance(item, dict):
            cid = item.get("id")
            if isinstance(cid, str):
                out.append(cid)
    return out


@router.post("/ai/v1/handbook/ask", include_in_schema=False)
async def handbook_ask(request: Request, body: HandbookAskRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend to have one (§105).
        return _degraded("mock_provider")

    if len(body.question.strip()) < 3:
        return _degraded("question_too_short")

    # The model never sees the whole dict — only the sections the retrieval lane believes are relevant,
    # sanitized exactly as they will be rendered.
    available_ids = {s.id for s in body.sections}
    corpus = "\n\n".join(
        f"[{s.id}] {s.title}\n{s.kicker}\n{s.body[:_MAX_SECTION_BODY]}" for s in body.sections
    )

    req = LLMRequest(
        task_class="summary",
        payload={"question": body.question, "locale": body.locale},
        system=contract_for("handbook", _SYSTEM),
        prompt=(
            f"Question: {body.question}\n\n"
            f"Sections ({len(body.sections)}):\n{corpus}\n\n"
            "JSON only."
        ),
        max_tokens=420,
        temperature=0.0,
        json_hint="json_object",
    )

    try:
        call = await deps.router().run(req)
    except Exception as exc:
        log.info("handbook ask: model unavailable — %s", exc)
        return _degraded("model_unavailable")

    raw = (call.response.text or "").strip()
    try:
        parsed = json.loads(raw) if raw else None
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        log.info("handbook ask: non-JSON reply from provider")
        return _degraded("non_json_reply")

    answer = parsed.get("answer")
    confidence = parsed.get("confidence")
    citations_in = parsed.get("citations", [])

    if not isinstance(answer, str) or not answer.strip():
        return _degraded("empty_answer")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if _URL_RE.search(answer):
        log.info("handbook ask: model emitted a URL — refusing")
        return _degraded("url_leak")

    cids = _citation_ids(citations_in)
    unknown = [c for c in cids if c not in available_ids]
    if unknown:
        log.info("handbook ask: model cited unknown sections %s", unknown)
        return _degraded("unknown_citation")

    if confidence.lower() != "low" and not cids:
        log.info("handbook ask: confident answer with zero citations — refusing")
        return _degraded("uncited_confident_answer")

    latency_ms = int((time.perf_counter() - started) * 1000)
    resp = {
        "answer": answer.strip()[:600],
        "citations": [
            {"id": c, "title": next((s.title for s in body.sections if s.id == c), "")}
            for c in cids[:3]
        ],
        "confidence": confidence.lower(),
        "degraded": bool(call.response.degraded),
        "provider": call.response.provider,
        "model": call.response.model,
        "measured": {
            "latency_ms": latency_ms,
            "prompt_tokens": int(call.response.prompt_tokens or 0),
            "completion_tokens": int(call.response.completion_tokens or 0),
            "cached_tokens": int(call.response.cached_tokens or 0),
            "cache_reported": bool(call.response.cache_reported),
            "cost_usd": float(call.response.cost_usd or 0.0),
        },
    }
    # The run ledger gets the honest truth; never blocks, never invents.
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "handbook_ask",
            "model": call.response.model,
            "provider": call.response.provider,
            "status": "degraded" if call.response.degraded else "completed",
            "input_summary": body.question[:120],
            "output_summary": answer.strip()[:180],
            "tool_calls": [],
            "prompt_tokens": int(call.response.prompt_tokens or 0),
            "completion_tokens": int(call.response.completion_tokens or 0),
            "cost_usd": float(call.response.cost_usd or 0.0),
            "latency_ms": latency_ms,
            "fallback_used": bool(call.response.degraded),
        })
    except Exception:
        log.warning("handbook ask: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
