"""`POST /ai/v1/chapter/ask` — the model walks beside the reader inside ONE chapter.

The web product renders every chapter deterministically (`GuideView`); nothing on that page
could rephrase a paragraph, and nothing should try. This is the optional third voice: it is
handed the chapter's own excerpts (chosen by the same kind of lexical pick the manual uses)
and answers one question in the reader's language, grounded there and nowhere else.

Hard discipline, identical in spirit to the manual lane:
- use ONLY the provided excerpts; never invent a character, plot beat, place, price or rule;
- if the chapter does not answer, say so in one sentence using the chapter's own vocabulary;
- citations must reference ids that were provided; a confident answer with no citation refuses;
- no URLs, no markdown, no code fences; at most ~360 characters;
- ANY violation — timeout, parse failure, leak, refusal — the response is `degraded` with an
  empty `answer`, and the page is left exactly as it was (the chapter, the right rail, the
  vocabulary cards: untouched).

Budget: task_class `summary`, temperature 0, at most one model call.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import ChapterAskRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for

log = logging.getLogger("nexus_ai.api.routes_chapter")

router = APIRouter()

_ATLAS_INDEX_PATH = Path(__file__).resolve().parent.parent / "models" / "atlas_index.txt"
_ATLAS_INDEX: str = ""
try:
    _ATLAS_INDEX = _ATLAS_INDEX_PATH.read_text(encoding="utf-8").strip()
except OSError:
    log.warning("chapter ask: atlas_index unreadable — falling back to bare contract")

_ATLAS_BLOCK = (
    "\n\nTHE 156-CHAPTER HONG KONG ARC — order is chronological. Use it to understand\n"
    "where this chapter sits in the world. The atlas grounds your answer in the world that actually exists.\n"
    "The chapter arc is synthetic narrative, never travel advice; merchants are fictional.\n"
    "Never name a character, place or rule beyond the provided excerpts.\n"
    + _ATLAS_INDEX
    + "\n"
) if _ATLAS_INDEX else ""

_SYSTEM = (
    "You are the NEXUS chapter companion. You will be given excerpts from ONE chapter of the Hong Kong story, "
    "a small atlas line that names the chapter's place inside the arc, optionally an ordered "
    "history of this same session's Q/A pairs on that chapter (oldest first), and ONE question in the reader's language.\n"
    "Answer in the SAME language as the question. Hard constraints:\n"
    "- Use ONLY the provided excerpts AND the atlas AND the history (it is your own prior, fenced answers). Never invent a character, an event, a place, a price or a rule that is not in them.\n"
    "- If the chapter does not contain the answer, reply with JSON: {\"answer\": \"<one sentence naming what the chapter does not say, in the chapter's own vocabulary>\", \"citations\": [], \"confidence\": \"low\"}. Never fill the gap with a guess.\n"
    "- Otherwise reply with JSON: {\"answer\": \"<short plain-prose answer in the question's language, grounded in the excerpts and the still-valid history, at most one excerpt cited inline in [square brackets]>\", \"citations\": [{\"id\": \"<id of the excerpt you used>\", \"title\": \"<the excerpt's own title>\"}], \"confidence\": \"high|medium|low\"}.\n"
    "- Every citation id must exist among the provided excerpts. Output JSON only. No URLs, no markdown links, no code fences, no bold, no tables.\n"
    "- The answer must be under 360 characters.\n"
    + _ATLAS_BLOCK
)

_MAX_SECTION_BODY = 1600

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)


def _degraded(reason: str) -> JSONResponse:
    """§105 fail-closed: an empty answer tells the web lane to show nothing at all."""
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


@router.post("/ai/v1/chapter/ask", include_in_schema=False)
async def chapter_ask(request: Request, body: ChapterAskRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend to have one (§105).
        return _degraded("mock_provider")

    if len(body.question.strip()) < 3:
        return _degraded("question_too_short")

    available_ids = {s.id for s in body.sections}
    corpus = "\n\n".join(
        f"[{s.id}] {s.title}\n{s.body[:_MAX_SECTION_BODY]}" for s in body.sections
    )

    chapter_atlas = (body.atlas_context or '').strip()
    atlas_block = (chapter_atlas + '\n') if chapter_atlas else ''
    history_lines: list[str] = []
    for i, turn in enumerate(body.history or [], 1):
        q = " ".join(str(turn.question).split())[:400]
        a = " ".join(str(turn.answer).split())[:480]
        if not a:
            continue
        history_lines.append(f"  Q{i}: {q}\n  A{i} (previously fenced answer): {a}")
    history_block = (
        "Conversation so far (oldest first; every answer below already passed the lane's fence):\n"
        + "\n".join(history_lines)
        + "\n"
    ) if history_lines else ""
    req = LLMRequest(
        task_class="summary",
        payload={"question": body.question, "locale": body.locale, "chapter_id": body.chapter_id,
                 "atlas_included": bool(chapter_atlas), "history_pairs": len(history_lines)},
        system=contract_for("chapter", _SYSTEM),
        prompt=(
            f"{atlas_block}Chapter: {body.chapter_title}\n"
            f"Content ({len(body.sections)} excerpts):\n{corpus}\n\n"
            f"{history_block}"
            f"Question: {body.question}\n"
            "JSON only."
        ),
        max_tokens=400,
        temperature=0.0,
        json_hint="json_object",
    )

    try:
        call = await deps.router().run(req)
    except Exception as exc:
        log.info("chapter ask: model unavailable — %s", exc)
        return _degraded("model_unavailable")

    raw = (call.response.text or "").strip()
    try:
        parsed = json.loads(raw) if raw else None
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        log.info("chapter ask: non-JSON reply from provider")
        return _degraded("non_json_reply")

    answer = parsed.get("answer")
    confidence = parsed.get("confidence")
    citations_in = parsed.get("citations", [])

    if not isinstance(answer, str) or not answer.strip():
        return _degraded("empty_answer")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if _URL_RE.search(answer):
        log.info("chapter ask: model emitted a URL — refusing")
        return _degraded("url_leak")

    cids = _citation_ids(citations_in)
    unknown = [c for c in cids if c not in available_ids]
    if unknown:
        log.info("chapter ask: model cited unknown excerpts %s", unknown)
        return _degraded("unknown_citation")

    if confidence.lower() != "low" and not cids:
        log.info("chapter ask: confident answer with zero citations — refusing")
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
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "chapter_ask",
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
        log.warning("chapter ask: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
