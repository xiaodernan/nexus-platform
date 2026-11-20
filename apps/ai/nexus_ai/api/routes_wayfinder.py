"""`POST /ai/v1/world/wayfinder` — the reader's next chapter, chosen by a StateGraph.

One click, one temperature-0 call. `wayfinder_graph` reads the real 163-chapter atlas, shortlists
REAL chapters around the reader's position/mood, lets the model transition the reader state to
one of them and write two grounded sentences, then fences every field. Mock mode is inert (§105).
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
from nexus_ai.contract import WayfinderRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for
from nexus_ai.orchestrator.wayfinder_graph import run_wayfinder

log = logging.getLogger("nexus_ai.api.routes_wayfinder")

router = APIRouter()

_EMPTY = {"chapter": 0, "title": "", "why": "", "notice": "", "confidence": "low"}


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={**_EMPTY, "degraded": True, "reason": reason})


@router.post("/ai/v1/world/wayfinder", include_in_schema=False)
async def wayfinder(request: Request, body: WayfinderRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()
    if deps.settings.uses_mock_llm:
        return _degraded("mock_provider")

    measured: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int) -> dict[str, Any] | None:
        nonlocal measured
        req = LLMRequest(
            task_class="summary",
            payload={"locale": body.locale, "position": body.position, "mood": body.mood},
            system=contract_for("wayfinder", system),
            prompt=prompt,
            max_tokens=int(max_tokens),
            temperature=0.0,
            json_hint="json_object",
        )
        call = await deps.router().run(req)
        response = call.response
        measured = {
            "prompt_tokens": int(response.prompt_tokens or 0),
            "completion_tokens": int(response.completion_tokens or 0),
            "cached_tokens": int(response.cached_tokens or 0),
            "cache_reported": bool(response.cache_reported),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "provider": response.provider,
            "model": response.model,
        }
        try:
            parsed = json.loads(response.text) if response.text else None
        except Exception:
            parsed = None
        return parsed if isinstance(parsed, dict) else None

    result = await run_wayfinder(
        locale=body.locale, position=body.position, mood=body.mood, llm_call=_llm_call,
    )
    degraded = bool(result.get("degraded"))
    resp: dict[str, Any] = {
        **_EMPTY,
        "chapter": int(result.get("chapter") or 0),
        "title": str(result.get("title") or ""),
        "why": str(result.get("reason") or ""),
        "notice": str(result.get("notice") or ""),
        "confidence": str(result.get("confidence") or "low"),
        "mood": str(result.get("mood") or body.mood),
        "degraded": degraded,
        **({"reason": str(result["reason"])} if degraded and result.get("reason") else {}),
        **({"measured": measured} if measured else {}),
    }
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "recommendation",
            "model": (measured or {}).get("model"),
            "provider": (measured or {}).get("provider"),
            "status": "degraded" if degraded else "completed",
            "input_summary": f"wayfinder pos={body.position} mood={body.mood} · {body.locale}"[:120],
            "output_summary": f"ch{resp['chapter']} {resp['reason']}"[:180],
            "tool_calls": [],
            "prompt_tokens": int((measured or {}).get("prompt_tokens") or 0),
            "completion_tokens": int((measured or {}).get("completion_tokens") or 0),
            "cost_usd": 0.0,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "fallback_used": degraded,
        })
    except Exception:
        log.warning("wayfinder: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
