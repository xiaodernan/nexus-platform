"""`POST /ai/v1/query/understand`, `POST /ai/v1/recommend`, `POST /ai/v1/compare` (§7).

All three reuse the shared pipeline, so intents/recommendations/comparisons are built
from the same grounding discipline: comparisons render only values that resolve to a
fact (or a computed fact the card itself synthesised with source+timestamp), and
recommendations carry the citations that back their explanations (§18/§19).
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nexus_ai.api import errors, runs
from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.deps import Deps
from nexus_ai.api.pipeline import compose_summary, run_search, understand
from nexus_ai.contract import (
    MAX_QUERY_LENGTH, CompareRequest, CompareResponse, CompareRow, RecommendRequest, RecommendResponse, UnderstandRequest, UnderstandResponse)
from nexus_ai.search.cards import (compute_open, drop_ungrounded_reasons, meters_text,
                                   travel_minutes)
from nexus_ai.trust.facts import FactBundle, facts_from_rows

log = logging.getLogger("nexus_ai.api.routes_discover")

router = APIRouter()


def _bad_request(message: str) -> JSONResponse:
    # D438: the envelope comes from the contract's own shape.
    return errors.error_response("validation_error", message,
                                  request_id=runs.current_request_id() or None,
                                  status=422)


# --------------------------------------------------------------------------- understand
@router.post("/ai/v1/query/understand")
async def query_understand(request: Request, body: UnderstandRequest):
    deps: Deps = request.app.state.deps
    query = (body.query or "").strip()
    if not query or len(query) > MAX_QUERY_LENGTH:
        return _bad_request(f"query is required and must be <= {MAX_QUERY_LENGTH} chars")
    started = time.perf_counter()
    # D437: the run id is created BEFORE the model call, so the cost ledger's row can
    # name the run it belongs to.
    run_id = runs.new_id()
    res = await understand(query, deps=deps, context=body.context, agent_run_id=run_id)
    # D466: the answer IS the intent (the contract's §7 row, the §7.1 shape, the cross-lane
    # `Intent` type, the SDK's `Promise<Intent>` and the web's own mock all say so). The
    # service's three extras - the provider, the §105 degraded flag and §8's one follow-up
    # question - ride at the root, where the cross-lane type already puts `provider`.
    payload = UnderstandResponse(
        **res.intent.model_dump(),
        provider=res.provider, degraded=res.degraded,
        follow_up_question=res.follow_up_question)
    # D432: the intent extraction is a task (AGENT_CONTRACT §8), so it writes a run.
    # D461: the run's `agent` names a ROSTER agent (§1 - the authoritative list). The
    # intent extraction is the planner's work, and the planner is `user_intent`; the name
    # that stood here ("intent_extract") is the ROUTER's task class (§9), which is a
    # different thing entirely, and D432's entry called it "the contract's roster name".
    await runs.record_run(deps, {
        "agent_run_id": run_id, "agent": "user_intent",
        "status": "succeeded", "provider": res.provider, "model": None,
        "conversation_id": None, "user_id": None, "tenant_id": deps.tenant_id(),
        "input_summary": query[:500] or None,
        "output_summary": str(getattr(res.intent, "intent", "") or ""),
        "plan": {"steps": ["intent_rules"]}, "tool_calls": [],
        "retrieval": [], "fact_ids": [],
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "fallback_used": "state_merge" if res.provider == "rules" else None,
        "error": None, "started_at": None, "finished_at": None,
        # D437: the tokens and the cost the model layer measured, not zeros.
        "prompt_tokens": int(res.usage.get("prompt_tokens") or 0),
        "completion_tokens": int(res.usage.get("completion_tokens") or 0),
        "cost_usd": float(res.usage.get("cost_usd") or 0.0),
        "degraded": bool(res.degraded),
    }, llm_records=list(res.llm_records or []))
    # D451: the degraded flag travels in the body AND the header (OBSERVABILITY.md §2).
    return degraded_json(payload.model_dump(mode="json"))


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
        return errors.error_response("ai_unavailable", str(exc),
                                      request_id=runs.current_request_id() or None,
                                      status=503)
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

    # D432: the response hands the caller an `agent_run_id`, so a run row has to carry
    # it - otherwise the id points at nothing.
    await runs.record_run(deps, {
        "agent_run_id": str(data["agent_run_id"]), "agent": "recommendation",
        "status": "succeeded", "provider": pack.response.provider, "model": None,
        "conversation_id": str(body.conversation_id) if body.conversation_id else None,
        "user_id": str(body.user_id) if body.user_id else None,
        "tenant_id": deps.tenant_id(),
        "input_summary": (query or intent.raw_query)[:500] or None,
        "output_summary": f"{len(pack.cards)} cards",
        "plan": {"steps": ["intent_rules", "search_merchants"]},
        "tool_calls": [{"tool": "search_merchants", "ok": True,
                        "ms": int(pack.response.took_ms)}],
        "retrieval": [],
        "fact_ids": [str(f.fact_id) for c in pack.cards for f in (c.facts or [])],
        "latency_ms": latency_ms, "cost_usd": 0.0, "fallback_used": None, "error": None,
        "started_at": None, "finished_at": None, "degraded": bool(pack.degraded),
    })

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
    # D451: the degraded flag travels in the body AND the header (OBSERVABILITY.md §2).
    return degraded_json(data)


# --------------------------------------------------------------------------- compare
# D449: the attribute list that used to stand here was dead - nothing read it - and it
# had gone out of date: it named an `open_hours` row (the grid's row is `open_state`, §422)
# and an `availability` row the grid does not have. The grid below builds its rows
# explicitly, and the ledger of what it builds is the test, not a list nobody reads.


async def _compare_rows(deps: Deps, subject_ids: list[str], tenant: str,
                        locale: str, geo: Any = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Collect (rows, meta) for the comparison grid from facts + published rows only.

    D401: a `geo` adds the `distance` row. The distances come from the same primary
    location the search's geo lane reads, so the two lanes cannot disagree about how
    far a merchant is.
    """
    meta: dict[str, Any] = {"source": "static", "degraded": deps.backend_degraded()}
    hours_map: dict[str, list[Any]]
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
        hours_map = {}
        hours_rows = await backend.hours(list({str(r.get("merchant_id"))
                                               for r in entity_rows}))
        for h in hours_rows:
            hours_map.setdefault(str(h["merchant_id"]), []).append(h)

    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    facts = FactBundle(facts_from_rows(fact_rows, now=now))
    distances: dict[str, float] = {}
    districts: dict[str, str] = {}
    if geo is not None and db is not None:
        from nexus_ai.search.sql import compare_geo

        d_sql, d_params = compare_geo(tenant, [str(r["merchant_id"]) for r in entity_rows],
                                       float(geo.lat), float(geo.lng))
        if d_sql:
            for d in await db.readonly(d_sql, *d_params, schema=deps.settings.db_search_path):
                mid = str(d["merchant_id"])
                if d.get("meters") is not None:
                    distances[mid] = float(d["meters"])
                if d.get("district") is not None:
                    districts[mid] = str(d["district"])
    return _grid(entity_rows, facts, hours_map, now=now, locale=locale,
                 distances=distances, districts=districts), meta


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
          hours_map: dict[str, list[Any]], *, now: Any, locale: str,
          distances: dict[str, float] | None = None,
          districts: dict[str, str] | None = None
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
        if cat_fact is None and cat is not None:
            # D401: a cell with no fact id renders as the unverified marker, so a
            # category nobody could check was a row of "unverified" in the table. The
            # category is the merchant's OWN claim (its own column), so it gets a
            # fact with the source and the timestamp, exactly like the open_state
            # row above.
            cat_fact = bundle.synth(
                subject_type="merchant", subject_id=sid, attribute="category",
                value={"value": cat}, source="merchant", confidence=0.9, observed_at=now)
        cat_cells.append(_cell(cat, cat_fact))
        addr_fact = bundle.get("address", sid)
        district = addr_fact.value.get("district") if addr_fact and isinstance(
            addr_fact.value, dict) else row.get("district")
        if district is None and districts:
            # D401: the entity rows carry no district column, so the grid's district row
            # was empty and dropped every time. The primary location's district is the
            # same fact the address fact would carry.
            district = districts.get(str(row.get("merchant_id") or sid))
        if addr_fact is None and district is not None:
            # The district is the merchant's own claim about where it is, so it gets a
            # fact with the source and the timestamp, the way the open_state row does.
            addr_fact = bundle.synth(
                subject_type="merchant", subject_id=sid, attribute="address",
                value={"district": district}, source="merchant", confidence=0.9,
                observed_at=now)
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

    # D401: the distance row, when the caller gave a point to measure from.
    distance_cells: list[dict[str, Any]] = []
    if distances:
        for sid in order:
            row = column_for(sid)
            meters = distances.get(str(row.get("merchant_id") or sid))
            if meters is None:
                distance_cells.append(_cell(None, None))
                continue
            d_fact = bundle.synth(
                subject_type="merchant", subject_id=sid, attribute="distance_m",
                value={"meters": int(round(meters)), "text": meters_text(meters),
                       "travel_minutes": travel_minutes(meters)},
                source="inferred", confidence=0.95, observed_at=now)
            distance_cells.append(_cell(meters_text(meters), d_fact))

    for attribute, cells in (("price", price_cells), ("rating", rating_cells),
                             ("category", cat_cells), ("district", district_cells),
                             ("open_state", open_cells),
                             ("distance", distance_cells)):
        compare_row = CompareRow(attribute=attribute, cards=cells)
        if any(c["value"] is not None for c in compare_row.cards):
            rows.append(compare_row.model_dump(mode="json"))
    return rows


@router.post("/ai/v1/compare")
async def compare(request: Request, body: CompareRequest):
    deps: Deps = request.app.state.deps
    ids = [str(i) for i in body.subject_ids]
    started = time.perf_counter()
    try:
        rows, meta = await _compare_rows(deps, ids, str(body.tenant_id or deps.tenant_id()),
                                         body.locale, body.geo)
    except Exception as exc:
        log.exception("compare read failed")
        return errors.error_response("ai_unavailable", str(exc),
                                      request_id=runs.current_request_id() or None,
                                      status=503)
    # D460: the comparison is a task (it reads merchants, builds a grid and grounds every
    # cell in a fact), so it writes a run like every other task - the D432 census walked
    # the service's endpoints and never asked this one, so the work it does was not
    # recorded anywhere: "why did the comparison put these two side by side" had no
    # answer. The grid's facts are its `fact_ids` (they are facts, unlike the retrieval's
    # chunk ids) and the compared merchants are its `retrieval`.
    latency_ms = int((time.perf_counter() - started) * 1000)
    await runs.record_run(deps, {
        "agent_run_id": runs.new_id(), "agent": "compare_entities",
        "status": "succeeded", "provider": "none", "model": None,
        "conversation_id": None,
        "user_id": None,
        "tenant_id": deps.tenant_id(),
        "input_summary": f"compare {len(ids)} subjects",
        "output_summary": f"{len(rows)} rows",
        "plan": {"steps": ["compare_entities"]},
        "tool_calls": [{"tool": "compare_entities", "ok": True, "ms": latency_ms}],
        "retrieval": ids, "fact_ids": _compare_fact_ids(rows),
        "latency_ms": latency_ms, "cost_usd": 0.0, "fallback_used": None, "error": None,
        "started_at": None, "finished_at": None, "degraded": bool(meta["degraded"]),
    })
    # D459: the degraded flag travels in the body AND the header (OBSERVABILITY.md §2).
    # The D452 census never reached this endpoint - the probe's request was invalid, so
    # it was never measured - and a degraded comparison looked like a normal one.
    # D467: the comparison's answer is built through the contract's model - it had no
    # model at all, so nothing described its shape.
    return degraded_json(CompareResponse(
        rows=[CompareRow(**row) for row in rows], subjects=list(body.subject_ids),
        degraded=bool(meta["degraded"]), source=meta["source"]).model_dump(mode="json"))


def _compare_fact_ids(rows: list[dict[str, Any]]) -> list[str]:
    """The facts the comparison's grid was built from - the cells that carry one."""
    out: list[str] = []
    for row in rows:
        for cell in row.get("cards") or []:
            fact_id = cell.get("fact_id")
            if fact_id:
                out.append(str(fact_id))
    return out
