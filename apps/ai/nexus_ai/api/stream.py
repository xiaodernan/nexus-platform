"""The canonical SSE search stream — API_CONTRACT §7 + D13, and the §116 stage UX.

`search_stream_events()` is a pure async generator yielding `(event_name, data)` pairs;
the route wraps it with `sse.sse_frame`, so the stream's shape is identical whichever
transport wraps it, and an error can only ever leave the process as a canonical
`error` *event* (never an HTTP 500 after the stream started) — the web client's §105
fallback chain ("SSE failed → POST /ai/v1/search → keyword search") keys off that frame.

Event order (happy path), matching the web mock emitter
(`apps/web/src/lib/mock/index.ts:mockSearchStream`) exactly:

    status(understanding) → intent → status(searching) → status(comparing)
    → results → status(summarizing) → summary → done

On failure after `status(understanding)`: `error` and the stream closes (no `done`
follows an `error`; the client must not see both).

Determinism seams: `new_id()` / `monotonic_ms()` are module-level so tests can make the
whole byte stream reproducible and prove mock/live framing parity.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, AsyncIterator

from nexus_ai.api import errors, runs
from nexus_ai.api.pipeline import SearchPack, compose_summary, run_search, \
    understand
from nexus_ai.api.deps import Deps
from nexus_ai.api.sse import STREAM_STAGE_ORDER

log = logging.getLogger("nexus_ai.api.stream")

#: status copy is static, per-locale template text (the `status` events are user-legible
#: stages, never chain-of-thought — §7/§116). No facts, so nothing can drift from data.
STAGE_TEXT: dict[str, dict[str, str]] = {
    "zh-HK": {"understanding": "理解需求…", "searching": "搜索附近商户…",
              "comparing": "比較緊啲選擇…", "summarizing": "整理結果…"},
    "zh-CN": {"understanding": "理解需求…", "searching": "搜索附近商户…",
              "comparing": "比较这些选择…", "summarizing": "整理结果…"},
    "en": {"understanding": "Understanding your request…",
           "searching": "Searching nearby merchants…",
           "comparing": "Comparing the options…", "summarizing": "Summarising…"},
}


def monotonic_ms() -> int:
    """Seam for tests."""
    import time

    return time.monotonic_ns() // 1_000_000


def stage_text(locale: str, stage: str) -> str:
    from nexus_ai.models.base import norm_locale

    return STAGE_TEXT.get(norm_locale(locale), STAGE_TEXT["zh-HK"])[stage]


def _norm_locale(locale: str) -> str:
    from nexus_ai.models.base import norm_locale

    return norm_locale(locale)


def _context_geo(context: dict[str, Any]) -> Any:
    geo = context.get("geo")
    return geo if isinstance(geo, dict) else None


def _context_now(context: dict[str, Any]) -> datetime | None:
    raw = context.get("now") or context.get("reference_time")
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _party_size(context: dict[str, Any]) -> int | None:
    try:
        n = context.get("party_size")
        return int(n) if n is not None else None
    except (TypeError, ValueError):
        return None


async def search_stream_events(*, query: str, deps: Deps,
                               context: dict[str, Any] | None = None,
                               conversation_id: str | None = None,
                               previous_intent: dict[str, Any] | None = None,
                               limit: int = 8, user_id: str | None = None,
                               request_id: str | None = None) -> AsyncIterator[
                               tuple[str, Any]]:
    """The §7/D13 event generator. Yields (name, data); the caller frames the bytes."""
    context = dict(context or {})
    locale = str(context.get("locale") or deps.settings.default_locale)
    started = monotonic_ms()
    run_id = runs.new_id()
    stage_iter = iter(STAGE_ORDER)

    async def _status(stage: str) -> tuple[str, Any]:
        return ("status", {"stage": stage, "text": stage_text(locale, stage)})

    # -- 1. understanding ------------------------------------------------------
    yield await _status(next(stage_iter))
    try:
        # -- 2. intent ----------------------------------------------------------
        intent_res = await understand(query, deps=deps, context=context,
                                      previous_intent=previous_intent,
                                      agent_run_id=run_id)
        yield ("intent", intent_res.intent.model_dump(mode="json"))

        # -- 3. searching / 4. comparing / 5. results --------------------------
        yield await _status(next(stage_iter))
        pack: SearchPack = await run_search(
            deps, intent_res.intent, query=query, geo=_context_geo(context),
            now=_context_now(context), limit=limit, locale=locale, user_id=user_id)
        yield await _status(next(stage_iter))
        yield ("results", {"set_id": pack.set_id, "items": pack.items})

        # -- 6. summarizing / 7. summary ---------------------------------------
        yield await _status(next(stage_iter))
        summary = await compose_summary(deps, pack, locale=locale, agent_run_id=run_id)
        yield ("summary", {"text": summary.text, "citations": summary.citations})

        # -- 8. done ------------------------------------------------------------
    except Exception as exc:  # the §105 contract: failure travels INSIDE the stream
        log.exception("stream failed mid-request")
        # D455: the error frame is built by the one builder, from the contract's own error
        # body, and the code follows the one rule - so this stream and the merchant chat's
        # answer the same failure the same way.
        yield ("error", errors.error_frame(exc, request_id=request_id))
        _record(deps, run_id=run_id, status="failed", started=started,
                provider="none", degraded=True, conversation_id=conversation_id,
                query=query, intent=None, pack=None, summary=None, user_id=user_id,
                error=str(exc), fallback_used="stream_error")
        return

    latency = monotonic_ms() - started
    degraded = bool(intent_res.degraded or pack.degraded or summary.degraded)
    yield ("done", {
        "agent_run_id": run_id,
        "latency_ms": latency,
        "cost_usd": 0.0,
        "degraded": degraded,
        "provider": summary.provider if summary.provider != "rules" else
        intent_res.provider if intent_res.provider != "rules" else "mock",
    })
    _record(deps, run_id=run_id, status="succeeded", started=started,
            provider=summary.provider, degraded=degraded, conversation_id=conversation_id,
            query=query, intent=intent_res.intent, pack=pack, summary=summary,
            user_id=user_id, fallback_used=intent_res.note,
            usage_in=dict(intent_res.usage or {}),
            llm_records=list(intent_res.llm_records or []) +
            list(getattr(summary, "llm_records", None) or []))


STAGE_ORDER = STREAM_STAGE_ORDER  # ("understanding", "searching", "comparing", "summarizing")


def _record(deps: Deps, *, run_id: str, status: str, started: int, provider: str,
            degraded: bool, conversation_id: str | None, query: str,
            intent: Any, pack: SearchPack | None, summary: Any,
            user_id: str | None, error: str | None = None,
            fallback_used: str | None = None, usage_in: dict[str, Any] | None = None,
            llm_records: list[Any] | None = None) -> None:
    """Ledger + best-effort persistence; an observability failure never breaks a stream."""
    fact_ids = summary.citations if summary else []
    # D437: the tokens and the cost the model layer measured - the intent's and the
    # summary's - rather than the zeros this row used to carry.
    usage = {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}
    for part in (usage_in or {}, getattr(summary, "usage", None) or {}):
        for key, value in part.items():
            if key == "cost_usd":
                usage["cost_usd"] = float(usage["cost_usd"]) + float(value or 0.0)
            else:
                usage[key] = int(usage.get(key, 0)) + int(value or 0)
    run = {
        "agent_run_id": run_id, "agent": "search", "status": status,
        "provider": provider, "model": "mock-heuristic-1" if provider == "mock" else
        provider,
        "conversation_id": conversation_id, "user_id": user_id,
        "tenant_id": deps.tenant_id(),
        "input_summary": query[:500],
        "output_summary": (summary.text[:500] if summary else None),
        "plan": {"steps": ["intent_extract", "search_merchants", "summary"]}
        if intent is not None else {"steps": ["intent_extract"]},
        "tool_calls": [{"tool": "search_merchants", "ok": pack is not None,
                        "ms": int(pack.response.took_ms) if pack else 0}]
        if pack else [],
        "fact_ids": fact_ids, "latency_ms": monotonic_ms() - started,
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "cost_usd": float(usage.get("cost_usd") or 0.0),
        "fallback_used": fallback_used, "error": error,
        "started_at": None, "finished_at": None,
        "degraded": degraded,
    }
    deps.ledger.add({**run, "persisted": False})
    db = deps.database()
    if db is None:
        return
    event = {
        "event_id": runs.new_id(), "name": "search", "tenant_id": deps.tenant_id(),
        "actor_type": "user" if user_id else "anonymous", "actor_id": user_id,
        "conversation_id": conversation_id,
        "properties": {"query": query[:200], "result_count": len(pack.items) if pack
                       else 0, "degraded": degraded},
        "context": {},
    } if status == "succeeded" else None

    async def _persist() -> None:
        # D448: the run and the cost ledger go in together, the run first - the ledger
        # row refers to it.
        await runs.persist_run(db, run, search_event=event, llm_records=llm_records)

    try:
        import asyncio

        task = asyncio.create_task(_persist())
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    except RuntimeError:  # no running loop (unit tests calling _record directly)
        log.debug("no event loop; run recorded in-memory only")
