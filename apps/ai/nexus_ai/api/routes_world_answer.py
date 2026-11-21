"""D1497 — `POST /ai/v1/world/answer`: ask the whole corpus, fenced.

One explicit reader question. `chapter_rag` retrieves real chapter bodies across the full
series; `world_answer_graph` phrases one short answer and refuses URLs / invented chapter
numbers. Mock mode is inert (§105). Service-to-service.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api.deps import Deps
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for
from nexus_ai.orchestrator.world_answer_graph import DEPTH_BUDGETS, DEPTH_DEFAULT, run_world_answer

log = logging.getLogger("nexus_ai.api.routes_world_answer")

router = APIRouter()

_EMPTY = {"answer": "", "confidence": "low"}


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={**_EMPTY, "degraded": True, "reason": reason})


@router.post("/ai/v1/world/answer", include_in_schema=False)
async def world_answer(request: Request, body: dict[str, Any]) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()
    if deps.settings.uses_mock_llm:
        return _degraded("mock_provider")
    query = str(body.get("query") or "").strip()
    if not query or len(query) > 200:
        return _degraded("invalid_query")
    locale = str(body.get("locale") or "zh-HK")
    # D1514: depth is a closed vocabulary owned by the server, never a raw budget from
    # the client. Unknown values degrade to `quick` inside run_world_answer.
    depth = str(body.get("depth") or DEPTH_DEFAULT)
    if depth not in DEPTH_BUDGETS:
        depth = DEPTH_DEFAULT

    measured: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int) -> dict[str, Any] | None:
        nonlocal measured
        req = LLMRequest(
            task_class="summary",
            payload={"query": query, "locale": locale},
            system=contract_for("world_answer", system),
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

    result = await run_world_answer(query=query, locale=locale, llm_call=_llm_call, depth=depth)
    degraded = bool(result.get("degraded"))
    resp: dict[str, Any] = {
        "answer": str(result.get("answer") or ""),
        "confidence": str(result.get("confidence") or "low"),
        "chapters": result.get("chapters") or [],
        "depth": str(result.get("depth") or depth),
        "budget": result.get("budget") or {},
        "degraded": degraded,
        **({"reason": str(result["reason"])} if result.get("reason") else {}),
        **({"measured": measured} if measured else {}),
    }
    return JSONResponse(status_code=200, content=resp)
