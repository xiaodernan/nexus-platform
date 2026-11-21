"""D1502 — `POST /ai/v1/world/web-facts`: real web data through the SSRF-guarded tool.

§九 asks for real, networked data rather than demo-only content. `search_web` already
exists as a guarded registry tool; this route gives it a read-only HTTP door so the world
page can show REAL public reference facts (Wikipedia) about the city the fiction sits in.
No LLM tokens: the tool is deterministic lexical search, and every row is marked
third-party / low-confidence so nothing is mistaken for product fact. Mock mode is inert.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api.deps import Deps

router = APIRouter()


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={
        "query": "", "results": [], "source": "third_party",
        "confidence": "low", "degraded": True, "reason": reason,
    })


@router.post("/ai/v1/world/web-facts", include_in_schema=False)
async def web_facts(request: Request, body: dict[str, Any]) -> JSONResponse:
    deps: Deps = request.app.state.deps
    if deps.settings.uses_mock_llm:
        return _degraded("mock_provider")
    query = str(body.get("query") or "").strip()
    if not query or len(query) > 120:
        return _degraded("invalid_query")
    language = "en" if str(body.get("language") or "zh") == "en" else "zh"
    started = time.perf_counter()
    try:
        result = await deps.tool_registry().dispatch(
            subject="web-facts-reader", tool="search_web",
            arguments={"query": query, "language": language},
        )
    except Exception as exc:
        return _degraded(f"web_search_unavailable:{type(exc).__name__}")
    return JSONResponse(status_code=200, content={
        "query": query,
        "results": result.get("results", []),
        "source": "third_party",
        "confidence": "low",
        "degraded": bool(result.get("degraded", False)),
        **({"reason": result["reason"]} if result.get("reason") else {}),
        "latency_ms": int((time.perf_counter() - started) * 1000),
    })
