"""`POST /ai/v1/story/recap` — the reader's orientation: where this window of the arc stands.

One CTA, one temperature-0 call. The `story_recap_graph` selects at most twelve real atlas lines,
the model phrases them, and the deterministic fence refuses URLs, invented chapter numbers and
name drift before anything reaches the reader. In mock mode the lane is inert (§105).
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
from nexus_ai.contract import StoryRecapRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for
from nexus_ai.orchestrator.story_recap_graph import run_recap

log = logging.getLogger("nexus_ai.api.routes_story_recap")

router = APIRouter()


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={
        "recap": "", "watch": "", "confidence": "low", "degraded": True, "reason": reason,
    })


@router.post("/ai/v1/story/recap", include_in_schema=False)
async def story_recap(request: Request, body: StoryRecapRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()
    if deps.settings.uses_mock_llm:
        return _degraded("mock_provider")

    measured: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int) -> dict[str, Any] | None:
        nonlocal measured
        req = LLMRequest(
            task_class="summary",
            payload={"locale": body.locale, "start": body.start, "end": body.end},
            system=contract_for("story_recap", system),
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

    result = await run_recap(locale=body.locale, start=body.start, end=body.end, llm_call=_llm_call)
    degraded = bool(result.get("degraded"))
    resp: dict[str, Any] = {
        "recap": str(result.get("recap") or ""),
        "watch": str(result.get("watch") or ""),
        "confidence": str(result.get("confidence") or "low"),
        "degraded": degraded,
        **({"reason": str(result["reason"])} if result.get("reason") else {}),
        **({"measured": measured} if measured else {}),
    }
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "recommendation",
            "model": (measured or {}).get("model"),
            "provider": (measured or {}).get("provider"),
            "status": "degraded" if degraded else "completed",
            "input_summary": f"recap {body.start}-{body.end} · {body.locale}"[:120],
            "output_summary": resp["recap"][:180],
            "tool_calls": [],
            "prompt_tokens": int((measured or {}).get("prompt_tokens") or 0),
            "completion_tokens": int((measured or {}).get("completion_tokens") or 0),
            "cost_usd": 0.0,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "fallback_used": degraded,
        })
    except Exception:
        log.warning("story recap: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
