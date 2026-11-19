"""`POST /ai/v1/insights/analyst` — the analyst StateGraph, served for the operator's daily scan.

Same posture as the narrative lane, one notch deeper: this lane measures the replay with
deterministic code, then lets the model (a) project the next seven days standing on those
measurements and (b) propose at most three next-step optimisation measures, each tied to one
measured number. Both replies pass through the graph's fences — a URL, a digit the replay never
carried, a wrong-language draft or anything over the length cap collapses to the deterministic
fallback, exactly like the world guide.

In mock mode (CI / offline) the lane is inert: `degraded: true, reason: 'mock_provider'`, empty
fields; the page renders exactly its deterministic replay and nothing else.

Budget: task_class `summary`, temperature 0, at most two model calls.
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
from nexus_ai.contract import InsightsAnalystRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for
from nexus_ai.orchestrator.insights_analyst_graph import run_analyst

log = logging.getLogger("nexus_ai.api.routes_insights_analyst")

router = APIRouter()


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "verdict": "flat",
            "forecast": "",
            "watch": "",
            "measures": [],
            "source": "fallback",
            "confidence": "low",
            "degraded": True,
            "reason": reason,
        },
    )


@router.post("/ai/v1/insights/analyst", include_in_schema=False)
async def insights_analyst(request: Request, body: InsightsAnalystRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend to have one (§105).
        return _degraded("mock_provider")

    stats = body.stats.model_dump()
    locale = body.locale

    measured_any: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int) -> dict[str, Any] | None:
        nonlocal measured_any
        req = LLMRequest(
            task_class="summary",
            payload={"locale": locale},
            system=contract_for("insights_analyst", system),
            prompt=prompt,
            max_tokens=int(max_tokens),
            temperature=0.0,
            json_hint="json_object",
        )
        call = await deps.router().run(req)
        raw = (call.response.text or "").strip()
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = None
        prev = measured_any or {
            "calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
            "cached_tokens": 0, "cost_usd": 0.0, "cache_reported": False,
        }
        prev = dict(prev)
        measured_any = {
            "calls": prev["calls"] + 1,
            "prompt_tokens": prev["prompt_tokens"] + int(call.response.prompt_tokens or 0),
            "completion_tokens": prev["completion_tokens"] + int(call.response.completion_tokens or 0),
            "cached_tokens": prev["cached_tokens"] + int(call.response.cached_tokens or 0),
            "cache_reported": bool(prev["cache_reported"] or call.response.cache_reported),
            "cost_usd": prev["cost_usd"] + float(call.response.cost_usd or 0.0),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "provider": call.response.provider,
            "model": call.response.model,
            "temperature": 0.0,
        }
        return parsed if isinstance(parsed, dict) else None

    result = await run_analyst(locale=locale, stats=stats, llm_call=_llm_call)

    source = str(result.get("source") or "fallback")
    measures = result.get("measures") or []
    degraded = source == "fallback"

    resp: dict[str, Any] = {
        "verdict": str(result.get("verdict") or "flat"),
        "forecast": str(result.get("forecast") or "")[:400],
        "watch": str(result.get("watch") or "")[:120],
        "measures": [
            {"action": str(m.get("action") or "")[:120],
             "why": str(m.get("why") or "")[:120]}
            for m in measures[:3]
            if isinstance(m, dict)
        ],
        "source": source,
        "confidence": str(result.get("confidence") or "low"),
        "locale": locale,
        "degraded": degraded,
        **({"reason": str(result["guard"])} if result.get("guard") else {}),
        **({"measured": measured_any} if measured_any else {}),
    }

    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "recommendation",  # the roster's synthesiser (AGENT_CONTRACT §1) — this IS one
            "model": (measured_any or {}).get("model"),
            "provider": (measured_any or {}).get("provider"),
            "status": "degraded" if degraded else "completed",
            "input_summary": f"analyst · {locale} · week {stats.get('week', {}).get('weeklyTotal', 0)}"[:120],
            "output_summary": str(result.get("forecast") or "")[:180],
            "tool_calls": [],
            "prompt_tokens": int((measured_any or {}).get("prompt_tokens") or 0),
            "completion_tokens": int((measured_any or {}).get("completion_tokens") or 0),
            "cost_usd": float((measured_any or {}).get("cost_usd") or 0.0),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "fallback_used": degraded,
        })
    except Exception:
        log.warning("analyst: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
