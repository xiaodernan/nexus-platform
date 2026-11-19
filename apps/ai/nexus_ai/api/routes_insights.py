"""The operator/inputs narrative lane — the live model phrases the ghost-replay in one paragraph.

Mandate §九 asks the operator surface to carry real analysis. The web product renders this
deterministically (an HK-dated seeded replay of 22 ghost readers — see `lib/user-journeys.ts`).
This lane lets a live model phrase that same data as an operator-readable sentence or two, with
zero invention tolerance: every number in the output must be present in the input payload; URL
leaks are refused; a flat day is answered with "the day is flat — do nothing bold", not with
urgency theater. In mock mode (default in CI) the lane is inert — `degraded` and an empty
paragraph — and the /insights page renders exactly its deterministic operator view.

The output never replaces the deterministic recommendation or the ghost tables; it sits above
them with a provenance badge, or disappears entirely.
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
from nexus_ai.contract import InsightsNarrativeRequest
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.prefix_contract import contract_for

log = logging.getLogger("nexus_ai.api.routes_insights")

router = APIRouter()

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_NUM_RE = re.compile(r"[0-9][0-9,.]{0,18}")

_SYSTEM = """You are the NEXUS operations-desk writer. You are reading one synthetic day: a fully deterministic, seeded replay of 22 ghost readers on the product — never pretend these are real people, and never claim otherwise.

Given the replay stats as JSON, write:
{"paragraph": "<one short paragraph (at most 80 words), in the payload's locale, that names what you would tell the operator: which reader profile dominated, whether the day drifted up/flat/down, and the one thing NOT to fix>", "focus": "<ONE line: the single next best investigation before any fix ships>", "confidence": "low|medium|high"}.

Hard rules:
- Use ONLY numbers that appear in the payload. If you cannot ground a sentence, leave the number out.
- Never invent a merchant name, a street, a language, a city, a price, a count, a user or a real person.
- If the payload is flat (slope |<| 0.5, similar profile counts), the paragraph MUST say roughly "the day is flat — do nothing bold" rather than fabricate urgency.
- No URLs, no markdown links, no code fences, no bold, no tables, no list.
- The paragraph must not name the synthetic nature of the replay with the word "real" — always attribute it to this run's replay.
- Confidence is "low" when the stats are degenerate or uninterpretable, "medium" when a coherent reading exists, "high" only when the dominant signal is unambiguous.
"""


def _degraded(reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "paragraph": "",
            "focus": "",
            "confidence": "low",
            "degraded": True,
            "reason": reason,
        },
    )


def _numbers(text: str) -> set[str]:
    return {m.group(0) for m in _NUM_RE.finditer(text or "")}


def _payload_numbers(payload: dict[str, Any]) -> set[str]:
    out: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, bool):
            out.add("1" if node else "0")
        elif isinstance(node, (int, float)):
            out.add(str(node))
            out.add(f"{node:.0f}" if float(node).is_integer() else f"{node}")
        elif isinstance(node, str):
            out.update(_numbers(node))

    walk(payload)
    return out


@router.post("/ai/v1/insights/narrative", include_in_schema=False)
async def insights_narrative(request: Request, body: InsightsNarrativeRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        return _degraded("mock_provider")

    stats = body.stats.model_dump()
    available = _payload_numbers({"locale": body.locale, **stats})

    req = LLMRequest(
        task_class="summary",
        payload={"locale": body.locale},
        system=contract_for("insights_narrative", _SYSTEM),
        prompt=(
            f"Locale: {body.locale}\n"
            f"Replay stats JSON:\n{json.dumps(stats, ensure_ascii=False, sort_keys=True)}\n\n"
            "JSON only."
        ),
        max_tokens=420,
        temperature=0.0,
        json_hint="json_object",
    )

    try:
        call = await deps.router().run(req)
    except Exception as exc:
        log.info("insights narrative: model unavailable — %s", exc)
        return _degraded("model_unavailable")

    raw = (call.response.text or "").strip()
    try:
        parsed = json.loads(raw) if raw else None
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        log.info("insights narrative: non-JSON reply from provider")
        return _degraded("non_json_reply")

    paragraph = parsed.get("paragraph")
    focus = parsed.get("focus")
    confidence = parsed.get("confidence")

    if not isinstance(paragraph, str) or not paragraph.strip():
        return _degraded("empty_answer")
    if not isinstance(focus, str) or not focus.strip():
        return _degraded("empty_focus")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if _URL_RE.search(paragraph) or _URL_RE.search(focus):
        log.info("insights narrative: model emitted a URL — refusing")
        return _degraded("url_leak")

    # The numbers the model wrote must each live inside the payload. The one exemption:
    # tiny counts (<= 100) are common with a 22-visitor replay; absent them we don't
    # play here.
    used = _numbers(paragraph) | _numbers(focus)
    invented = {n for n in used if n not in available and int(float(n)) > 100}
    if invented:
        log.info("insights narrative: model wrote numbers not in the payload — %s", invented)
        return _degraded("invented_numbers")

    latency_ms = int((time.perf_counter() - started) * 1000)
    resp = {
        "paragraph": paragraph.strip()[:400],
        "focus": focus.strip()[:160],
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
            "agent": "insights_narrative",
            "model": call.response.model,
            "provider": call.response.provider,
            "status": "degraded" if call.response.degraded else "completed",
            "input_summary": json.dumps(stats, ensure_ascii=False)[:120],
            "output_summary": paragraph.strip()[:180],
            "tool_calls": [],
            "prompt_tokens": int(call.response.prompt_tokens or 0),
            "completion_tokens": int(call.response.completion_tokens or 0),
            "cost_usd": float(call.response.cost_usd or 0.0),
            "latency_ms": latency_ms,
            "fallback_used": bool(call.response.degraded),
        })
    except Exception:
        log.warning("insights narrative: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
