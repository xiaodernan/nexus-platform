"""`POST /ai/v1/world/guide` — the world guide: where to next, one honest step forward.

The reader is somewhere inside the arc with minutes to spare and asks for the next stop. The web
lane curates candidates (never the model's invention); the StateGraph in
`nexus_ai.orchestrator.world_guide_graph` classifies the situation, selects the two honest
doors, and the model phrases ONE recommendation in the reader's language — grounded only in the
two doors it was given.

Discipline, identical in spirit to the chapter-companion lane:
- candidates come from the web lane; the model picks between them (`pick` 1|2) and explains why;
- no other place may be named; a URL, a wrong-language draft, an over-long draft or an empty
  answer all collapse to the deterministic fallback template — the reader is never blocked;
- in mock mode (CI / offline) the lane is inert: `degraded:true, reason:'mock_provider'`, empty
  `answer`, the web island never mounts;
- the suggestion list the caller renders comes from the deterministic selection, never from the
  model's reply.

Budget: task_class `summary`, temperature 0, at most one model call.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import WorldGuideRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for
from nexus_ai.orchestrator.world_guide_graph import run_guide

log = logging.getLogger("nexus_ai.api.routes_world_guide")

router = APIRouter()


def _normalize_locale(raw: str | None) -> str:
    loc = (raw or "").strip().lower().replace("_", "-")
    if loc.startswith("en"):
        return "en"
    if loc.startswith("zh-cn") or loc.startswith("zh-sg") or loc.startswith("zh-hans"):
        return "zh-CN"
    if loc.startswith("zh"):
        return "zh-HK"
    return "zh-HK"


def _normalize_surface(raw: str | None) -> str:
    surface = (raw or "guides").strip().lower()
    return surface if surface in {"home", "guides", "chapter", "insights", "handbook"} else "guides"


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "answer": "",
            "suggestions": [],
            "source": "fallback",
            "intent": "explore",
            "degraded": True,
            "reason": reason,
        },
    )


@router.post("/ai/v1/world/guide", include_in_schema=False)
async def world_guide(request: Request, body: WorldGuideRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend to have one (§105).
        return _degraded("mock_provider")

    locale = _normalize_locale(body.locale)
    surface = _normalize_surface(body.surface)
    candidates = [
        {"slug": c.slug, "title": c.title, "blurb": c.blurb}
        for c in body.candidates
        if c.slug.strip() and c.title.strip()
    ]
    if not candidates:
        return _degraded("no_candidates")

    measured: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int = 320) -> dict[str, Any] | None:
        nonlocal measured
        req = LLMRequest(
            task_class="summary",
            payload={"surface": surface, "locale": locale, "minutes": body.minutes,
                     "current_title": body.current_title},
            system=contract_for("world_guide", system),
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=0.0,
            json_hint="json_object",
        )
        call = await deps.router().run(req)
        raw = (call.response.text or "").strip()
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = None
        measured = {
            "prompt_tokens": int(call.response.prompt_tokens or 0),
            "completion_tokens": int(call.response.completion_tokens or 0),
            "cached_tokens": int(call.response.cached_tokens or 0),
            "cache_reported": bool(call.response.cache_reported),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "cost_usd": float(call.response.cost_usd or 0.0),
            "provider": call.response.provider,
            "model": call.response.model,
            "temperature": 0.0,
        }
        if not isinstance(parsed, dict):
            return None
        return {"answer": parsed.get("answer"), "pick": parsed.get("pick")}

    result = await run_guide(
        locale=locale,
        surface=surface,
        current_title=body.current_title,
        minutes=body.minutes,
        candidates=candidates,
        llm_call=_llm_call,
    )

    source = str(result.get("source") or "fallback")
    degraded = source != "llm"
    answer = str(result.get("answer") or "").strip()
    suggestions = result.get("suggestions") or []

    resp: dict[str, Any] = {
        "answer": answer[:600],
        "suggestions": suggestions[:2],
        "source": source,
        "intent": str(result.get("intent") or "explore"),
        "locale": locale,
        "degraded": degraded,
        **({"reason": str(result["guard"])} if result.get("guard") else {}),
        **({"pick": result["pick"]} if result.get("pick") in (1, 2) else {}),
        **({"measured": measured} if measured else {}),
    }
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "recommendation",  # the roster's synthesiser (AGENT_CONTRACT §1) — this IS one
            "model": (measured or {}).get("model"),
            "provider": (measured or {}).get("provider"),
            "status": "degraded" if degraded else "completed",
            "input_summary": f"{surface} · {body.current_title[:80] or 'open ask'} · {body.minutes}min"[:120],
            "output_summary": answer[:180],
            "tool_calls": [],
            "prompt_tokens": int((measured or {}).get("prompt_tokens") or 0),
            "completion_tokens": int((measured or {}).get("completion_tokens") or 0),
            "cost_usd": float((measured or {}).get("cost_usd") or 0.0),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "fallback_used": degraded,
        })
    except Exception:
        log.warning("world guide: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
