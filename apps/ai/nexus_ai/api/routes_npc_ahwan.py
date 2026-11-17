"""`POST /ai/v1/npc/ah-wan` — Ah Wan, the night-shift tower cleaner, answers players at 1am.

The daily page embeds one in-world NPC from the HK arc (`hk-night-cleaner-chronicle`), and only
her. She is the only living voice the player can talk to inside the arc right now; the StateGraph
in `nexus_ai.orchestrator.npc_ahwan_dialogue` classifies the turn (deflect/voice) and writes it.

Discipline, identical to the other live lanes:
- the model may ONLY write Ah Wan, short, in the player's language, grounded in the arc;
- everything outside the world (politics, cash, live facts, URLs) never reaches a model call;
- a URL, a >240-char draft, a wrong-language draft, or an empty answer all collapse to the
  in-character deflection — the page never breaks and the story is never leaked;
- mock mode (CI/offline) the lane is inert: `degraded:true, reason:'mock_provider'`, the island
  never mounts.

Budget: task_class `summary`, temperature 0, at most one model call. No persistence, no fetch;
history rides the request from the client (capped, capped again here).
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
from nexus_ai.contract import AhWanDialogueRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.orchestrator.npc_ahwan_dialogue import run_dialogue

log = logging.getLogger("nexus_ai.api.routes_npc_ahwan")

router = APIRouter()


def _normalize_locale(raw: str | None) -> str:
    loc = (raw or "").strip().lower().replace("_", "-")
    if loc.startswith("en"):
        return "en"
    if loc.startswith("zh-cn") or loc.startswith("zh-hans") or loc.startswith("zh-sg"):
        return "zh-CN"
    return "zh-HK"


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "answer": "",
            "source": "fallback",
            "degraded": True,
            "reason": reason,
            "locale": _normalize_locale(None),
        },
    )


@router.post("/ai/v1/npc/ah-wan", include_in_schema=False)
async def npc_ah_wan(request: Request, body: AhWanDialogueRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend one happened (§105).
        return _degraded("mock_provider")

    locale = _normalize_locale(body.locale)
    history = [
        {"role": "user" if t.role == "user" else "assistant", "content": t.content}
        for t in body.history
        if t.content.strip()
    ][-12:]

    measured: dict[str, Any] | None = None

    async def _llm_call(system: str, prompt: str, max_tokens: int = 220) -> dict[str, Any] | None:
        nonlocal measured
        req = LLMRequest(
            task_class="summary",
            payload={"locale": locale, "history_turns": len(history)},
            system=system,
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
        return {"answer": parsed.get("answer")}

    result = await run_dialogue(
        locale=locale,
        message=body.message,
        history=history,
        llm_call=_llm_call,
    )

    source = str(result.get("source") or "fallback")
    degraded = source != "llm"
    answer = str(result.get("answer") or "").strip()

    resp: dict[str, Any] = {
        "answer": answer[:600],
        "source": source,
        "locale": locale,
        "degraded": degraded,
        **({"reason": str(result["guard"])} if result.get("guard") else {}),
        **({"measured": measured} if measured else {}),
    }
    try:
        await runs.record_run(deps, {
            "id": str(runs.new_id()),
            "agent": "merchant_agent",  # a conversational surface the roster does not name; declared
            "model": (measured or {}).get("model"),
            "provider": (measured or {}).get("provider"),
            "status": "degraded" if degraded else "completed",
            "input_summary": f"npc/ah-wan · {body.message[:90]}"[:120],
            "output_summary": answer[:180],
            "tool_calls": [],
            "prompt_tokens": int((measured or {}).get("prompt_tokens") or 0),
            "completion_tokens": int((measured or {}).get("completion_tokens") or 0),
            "cost_usd": float((measured or {}).get("cost_usd") or 0.0),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "fallback_used": degraded,
        })
    except Exception:
        log.warning("npc ah-wan: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
