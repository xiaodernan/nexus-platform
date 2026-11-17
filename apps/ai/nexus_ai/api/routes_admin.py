"""`POST /ai/v1/admin/digest` — the operator's mirror, read by the model, fenced by the numbers.

The /admin console renders the REAL backend counters (Redis event-stream length, consumer lag,
in-flight group pending, disabled / degraded flags). This lane reads the same numbers and asks
the model for two things only: one honest paragraph-shaped `reading`, and at most three concrete
`actions` an operator can take next.

Discipline, one notch stricter than the other lanes:
- the model may quote ONLY numbers present in the payload (plus the small structural digits);
  ANY other digit token in the reply ⇒ refused with `numeric_leak`;
- no URLs, no markdown, no code fences; at most ~220 characters of reading prose, ≤120 each action;
- if the system honestly has nothing to report (disabled or fully degraded with no pending work),
  the correct answer IS "nothing to act on" — the model is told to say exactly that;
- ANY failure — non-JSON, URL leak, numeric leak, empty output, dead provider — the response is
  `degraded:true` with empty content; the console renders the counters exactly as it did before.

Budget: task_class `summary`, temperature 0, at most one model call.
"""
from __future__ import annotations

import json
import logging
import re
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import AdminDigestRequest
from nexus_ai.models.base import LLMRequest

log = logging.getLogger("nexus_ai.api.routes_admin")

router = APIRouter()

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_DIGIT_RE = re.compile(r"\d+")
_MAX_LEN = 220
_MAX_ACTION = 120
#: Structural small digits the model may use for shape ("3 actions", "24 hours"), never as data.
_STRUCTURAL_OK = {str(n) for n in range(0, 11)} | {"24", "100", "2026"}

_SYSTEM = """You are the operator's digest reader for the NEXUS admin console. You will be given REAL aggregated counters from the backend event stream and ONE locale.
Answer in the SAME language as the locale. Hard constraints:
- Every number you write MUST appear in the payload (or be trivial shape digits like 3 actions / 24). If you want to write a number that is not there, STOP talking about it instead.
- Use ONLY the payload. Never invent a tenant, merchant, street, user id, percentage or trend that is not visibly implied by the counters.
- If the payload says disabled or degraded with nothing pending, say so in one sentence — "nothing to act on, the system is quiet" — and give at most one action (re-enable / check the flag).
- Otherwise reply with JSON: {"reading": "<one honest paragraph, at most 220 characters>", "actions": [{"action": "<one imperative, at most 120 chars>", "why": "<the counter it answers to, at most 120 chars>"}], "confidence": "low|medium|high"}.
- At most three actions, ordered by urgency. No URLs, no markdown links, no code fences, no bold, no tables. Output JSON only.
"""

def _degraded(reason: str) -> JSONResponse:
    """§105 fail-closed: empty content tells the console to render nothing at all."""
    return JSONResponse(
        status_code=200,
        content={
            "reading": "",
            "actions": [],
            "confidence": "low",
            "degraded": True,
            "reason": reason,
        },
    )


def _allowed_numbers(payload_obj: object) -> set[str]:
    allowed: set[str] = set(_STRUCTURAL_OK)
    raw = json.dumps(payload_obj, ensure_ascii=False)
    for m in _DIGIT_RE.finditer(raw):
        allowed.add(m.group(0))
    return allowed


def _numeric_leak(allowed: set[str], text: str) -> str | None:
    for m in _DIGIT_RE.finditer(text):
        token = m.group(0)
        if token in allowed:
            continue
        # also accept a token that is a substring of a payload number ("13" ⊂ "913") — no, reject: exact match only is the honest fence
        return token
    return None


@router.post("/ai/v1/admin/digest", include_in_schema=False)
async def admin_digest(request: Request, body: AdminDigestRequest) -> JSONResponse:
    deps: Deps = request.app.state.deps
    started = time.perf_counter()

    if deps.settings.uses_mock_llm:
        # CI and offline planes never pay for a live call nor pretend to have one (§105).
        return _degraded("mock_provider")

    payload = {"events": body.events.model_dump(), "locale": body.locale}
    allowed = _allowed_numbers(payload)
    corpus = json.dumps(payload, ensure_ascii=False, indent=2)

    req = LLMRequest(
        task_class="summary",
        payload={"locale": body.locale},
        system=_SYSTEM,
        prompt=(
            f"Real counters from the backend event stream ({body.locale}):\n{corpus}\n\n"
            "JSON only."
        ),
        max_tokens=500,
        temperature=0.0,
        json_hint="json_object",
    )

    try:
        call = await deps.router().run(req)
    except Exception as exc:
        log.info("admin digest: model unavailable — %s", exc)
        return _degraded("model_unavailable")

    raw = (call.response.text or "").strip()
    try:
        parsed = json.loads(raw) if raw else None
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        log.info("admin digest: non-JSON reply from provider")
        return _degraded("non_json_reply")

    reading = parsed.get("reading")
    confidence = parsed.get("confidence")
    actions = parsed.get("actions")

    if not isinstance(reading, str) or not reading.strip():
        return _degraded("empty_reading")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if _URL_RE.search(reading):
        return _degraded("url_leak")

    if not isinstance(actions, list):
        actions = []
    clean_actions: list[dict[str, str]] = []
    for item in actions[:3]:
        if not isinstance(item, dict):
            continue
        action = item.get("action")
        why = item.get("why")
        if not (isinstance(action, str) and action.strip()):
            continue
        clean_actions.append({
            "action": action.strip()[:_MAX_ACTION],
            "why": (why.strip()[:_MAX_ACTION] if isinstance(why, str) else ""),
        })
    if any(_URL_RE.search(a["action"] + " " + a["why"]) for a in clean_actions):
        return _degraded("url_leak")

    combined = reading + " " + " ".join(a["action"] + " " + a["why"] for a in clean_actions)
    leak = _numeric_leak(allowed, combined)
    if leak is not None:
        log.info("admin digest: model wrote a number (%s) not in the payload — refusing", leak)
        return _degraded("numeric_leak")

    latency_ms = int((time.perf_counter() - started) * 1000)
    resp = {
        "reading": reading.strip()[:_MAX_LEN],
        "actions": clean_actions,
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
            "agent": "admin_digest",
            "model": call.response.model,
            "provider": call.response.provider,
            "status": "degraded" if call.response.degraded else "completed",
            "input_summary": json.dumps(payload, ensure_ascii=False)[:120],
            "output_summary": reading.strip()[:180],
            "tool_calls": [],
            "prompt_tokens": int(call.response.prompt_tokens or 0),
            "completion_tokens": int(call.response.completion_tokens or 0),
            "cost_usd": float(call.response.cost_usd or 0.0),
            "latency_ms": latency_ms,
            "fallback_used": bool(call.response.degraded),
        })
    except Exception:
        log.warning("admin digest: run ledger write failed (continuing)", exc_info=True)
    return JSONResponse(status_code=200, content=resp)
