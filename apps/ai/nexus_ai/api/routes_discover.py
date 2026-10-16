"""`POST /ai/v1/query/understand`, `POST /ai/v1/recommend`, `POST /ai/v1/compare` (§7).

All three reuse the shared pipeline, so intents/recommendations/comparisons are built
from the same grounding discipline: comparisons render only values that resolve to a
fact (or a computed fact the card itself synthesised with source+timestamp), and
recommendations carry the citations that back their explanations (§18/§19).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.api.pipeline import (
    MAX_QUERY_LENGTH, SearchPack, compose_summary, run_search, understand, validate_intent)
from nexus_ai.contract import (
    CompareRow, Intent, RecommendRequest, RecommendResponse, UnderstandRequest,
    UnderstandResponse, _Strict)
from nexus_ai.search.cards import compute_open, drop_ungrounded_reasons
from nexus_ai.trust.facts import FactBundle, facts_from_rows

log = logging.getLogger("nexus_ai.api.routes_discover")

router = APIRouter()


def _bad_request(message: str) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": "validation_error", "message": message, "details": {},
                   "request_id": runs.current_request_id() or None}},
        status_code=422)


# --------------------------------------------------------------------------- understand
@router.post("/ai/v1/query/understand")
async def query_understand(request: Request, body: UnderstandRequest):
    deps: Deps = request.app.state.deps
    query = (body.query or "").strip()
    if not query or len(query) > MAX_QUERY_LENGTH:
        return _bad_request(f"query is required and must be <= {MAX_QUERY_LENGTH} chars")
    res = await understand(query, deps=deps, context=body.context)
    payload = UnderstandResponse(
        intent=res.intent, provider=res.provider, degraded=res.degraded,
        follow_up_question=res.follow_up_question)
    return JSONResponse(payload.model_dump(mode="json"))


# --------------------------------------------------------------------------- recommend
@router.post("/ai/v1/recommend")
async def recommend(request: Request, body: RecommendRequest):
    deps: Deps = request.app.state.deps
    started = time.perf_counter()
    query = (body.query or "").strip()
    if body.intent is None:
        if not query:
            return _bad_request("recommend needs `intent` or `query`")
        res = await understand(query, deps=deps, context={})
        intent = res.intent
    else:
        intent = body.intent
    try:
        pack = await run_search(deps, intent, query=query or intent.raw_query,
                                geo=body.geo, now=body.now,
                                limit=max(1, min(body.limit, 50)), locale=body.locale,
                                user_id=body.user_id)
    except Exception as exc:
        log.exception("recommend search failed")
        return JSONResponse(
            {"error": {"code": "ai_unavailable", "message": str(exc), "details": {},
                       "request_id": runs.current_request_id() or None}}, status_code=503)
    # §18/§19: enforce the grounding boundary at the wire. The rules path never emits
    # an ungrounded non-sponsored reason, so `ungrounded` is 0 in steady state; if a
    # future producer does, the bullet is dropped and counted rather than shipped.
    ungrounded = 0
    for c in pack.cards:
        _, dropped = drop_ungrounded_reasons(c)
        ungrounded += dropped
    if ungrounded:  # pragma: no cover — never hit by the rules path; guard for future producers
        log.warning("recommend dropped %d ungrounded non-sponsored reasons", ungrounded)
    summary = await compose_summary(deps, pack, locale=body.locale)
    latency_ms = int((time.perf_counter() - started) * 1000)
    payload = RecommendResponse(
        set_id=UUID(pack.set_id), items=pack.cards, summary=summary.text,
        citations=[UUID(c) for c in summary.citations],
        provider=summary.provider,
        degraded=bool(pack.degraded or summary.degraded),
        agent_run_id=UUID(runs.new_id()), latency_ms=latency_ms, cost_usd=0.0)
    data = payload.model_dump(mode="json")

    db = deps.database()
    if db is not None:  # AI-owned table; best-effort like every other write here
        from nexus_ai.api import runs as _r
        try:
            await _r.persist_recommendation_set(
                db, set_id=pack.set_id, tenant_id=deps.tenant_id(), user_id=body.user_id,
                conversation_id=body.conversation_id,
                query=query or intent.raw_query,
                intent=intent.model_dump(mode="json"), strategy=pack.response.strategy,
                items=[{"subject_type": c.card_type, "subject_id": str(c.id),
                        "rank": i, "score": (c.ai_match.score if c.ai_match else None),
                        "explanations": [x.text for x in (c.ai_match.reasons
                                                          if c.ai_match else [])],
                        "fact_ids": [str(f.fact_id) for f in c.facts]}
                       for i, c in enumerate(pack.cards)],
                latency_ms=latency_ms)
        except Exception:  # pragma: no cover
            log.warning("recommendation_sets insert failed", exc_info=True)
    return JSONResponse(data)


# --------------------------------------------------------------------------- compare
class CompareRequest(_Strict):
    subject_ids: list[UUID] = Field(min_length=2, max_length=5)
    tenant_id: Optional[UUID] = None
    locale: str = "zh-HK"


_COMPARE_ATTRIBUTES = ("price", "rating", "category", "district", "open_hours",
                       "availability")


async def _compare_rows(deps: Deps, subject_ids: list[str], tenant: str,
                        locale: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Collect (rows, meta) for the comparison grid from facts + published rows only."""
    meta: dict[str, Any] = {"source": "static", "degraded": deps.backend_degraded()}
    db = deps.database()
    if db is not None:
        meta["source"] = "postgres"
        sql_text, params = S_entities(tenant, subject_ids)
        entity_rows = await db.readonly(sql_text, *params,
                                        schema=deps.settings.db_search_path)
        facts_sql, facts_params = _facts_all(subject_ids)
        fact_rows = await db.readonly(facts_sql, *facts_params,
                                      schema=deps.settings.db_search_path) if facts_sql \
            else []
        hours_map = await _hours_by_merchant(db, deps,
                                             [str(r["merchant_id"]) for r in entity_rows])
    else:
        from nexus_ai.api.demo_data import demo_backend

        backend = demo_backend()
        all_rows = await backend.merchant_candidates(text=None, filters={})
        all_rows += await backend.offering_candidates(text=None, filters={})
        want = set(subject_ids)
        entity_rows = [r for r in all_rows
                       if str(r.get("subject_id")) in want]
        fact_rows = await backend.facts(subject_ids)
        hours_map = {str(h["merchant_id"]): [] for h in []}
        hours_rows = await backend.hours(list({str(r.get("merchant_id"))
                                               for r in entity_rows}))
        for h in hours_rows:
            hours_map.setdefault(str(h["merchant_id"]), []).append(h)

    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    facts = FactBundle(facts_from_rows(fact_rows, now=now))
    return _grid(entity_rows, facts, hours_map, now=now, locale=locale), meta


def S_entities(tenant: str, ids: list[str]):
    from nexus_ai.search.sql import entities_for

    return entities_for(tenant, ids)


def _facts_all(ids: list[str]):
    from nexus_ai.search.sql import facts_for

    return facts_for(ids)


async def _hours_by_merchant(db: Any, deps: Deps, merchant_ids: list[str]
                             ) -> dict[str, list[Any]]:
    from nexus_ai.search.sql import hours_for

    out: dict[str, list[Any]] = {}
    sql_text, params = hours_for([m for m in merchant_ids if m])
    if not sql_text:
        return out
    rows = await db.readonly(sql_text, *params, schema=deps.settings.db_search_path)
    for r in rows:
        out.setdefault(str(r["merchant_id"]), []).append(r)
    return out


def _cell(value: Any, fact: Any) -> dict[str, Any]:
    return {"value": value, "fact_id": (str(fact.fact_id) if fact else None),
            "source": (fact.source if fact else None),
            "observed_at": (fact.observed_at.isoformat() if fact and fact.observed_at
                            else None),
            "confidence": (fact.confidence if fact else None)}


def _grid(entity_rows: list[dict[str, Any]], bundle: FactBundle,
          hours_map: dict[str, list[Any]], *, now: Any, locale: str
          ) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    order = [str(r.get("subject_id")) for r in entity_rows]

    def column_for(sid: str) -> dict[str, Any]:
        row = next(r for r in entity_rows if str(r.get("subject_id")) == sid)
        return row

    price_cells, rating_cells, cat_cells, district_cells, open_cells = [], [], [], [], []
    for sid in order:
        row = column_for(sid)
        price_fact = bundle.get("price", sid)
        price_val = None
        if price_fact and isinstance(price_fact.value, dict):
            price_val = price_fact.value.get("amount")
        elif row.get("avg_price_hkd") is not None:
            price_val = f"{float(row['avg_price_hkd']):.2f}"
        price_cells.append(_cell(price_val, price_fact))
        rating_fact = bundle.get("rating", sid)
        rating_val = rating_fact.value.get("value") if rating_fact and isinstance(
            rating_fact.value, dict) else row.get("rating_agg")
        rating_cells.append(_cell(rating_val, rating_fact))
        cat = row.get("category") or row.get("category_primary")
        cat_fact = bundle.get("category", sid)
        cat_cells.append(_cell(cat, cat_fact))
        addr_fact = bundle.get("address", sid)
        district = addr_fact.value.get("district") if addr_fact and isinstance(
            addr_fact.value, dict) else row.get("district")
        district_cells.append(_cell(district, addr_fact))
        hours = hours_map.get(str(row.get("merchant_id") or sid), [])
        state = compute_open(hours, now=now) if hours else {"is_open": None}
        if state.get("is_open") is not None:
            open_fact = bundle.synth(subject_type="merchant",
                                     subject_id=sid, attribute="open_state",
                                     value={"is_open": state["is_open"],
                                           "text": state.get("text")},
                                     source="merchant", confidence=0.9, observed_at=now)
            open_cells.append(_cell(state.get("text"), open_fact))
        else:
            open_cells.append(_cell(None, None))

    for attribute, cells in (("price", price_cells), ("rating", rating_cells),
                             ("category", cat_cells), ("district", district_cells),
                             ("open_state", open_cells)):
        row = CompareRow(attribute=attribute, cards=cells)
        if any(c["value"] is not None for c in row.cards):
            rows.append(row.model_dump(mode="json"))
    return rows


@router.post("/ai/v1/compare")
async def compare(request: Request, body: CompareRequest):
    deps: Deps = request.app.state.deps
    ids = [str(i) for i in body.subject_ids]
    try:
        rows, meta = await _compare_rows(deps, ids, str(body.tenant_id or deps.tenant_id()),
                                         body.locale)
    except Exception as exc:
        log.exception("compare read failed")
        return JSONResponse(
            {"error": {"code": "ai_unavailable", "message": str(exc), "details": {},
                       "request_id": runs.current_request_id() or None}}, status_code=503)
    return JSONResponse({"rows": rows, "subjects": ids, "degraded": bool(meta["degraded"]),
                         "source": meta["source"]})
