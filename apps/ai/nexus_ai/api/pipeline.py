"""The shared request pipeline both stream and JSON endpoints run.

Kept in one module so `/ai/v1/search`, `/ai/v1/search/stream` and `/ai/v1/recommend`
cannot drift apart (§105: the stream's fallback target must be *the same* search, minus
the model layer). Trust discipline lives here:

* the rule-engine NLU is always the floor — an LLM failure degrades the turn to it
  rather than failing the request (D4);
* every summary string is post-validated against the grounding bundle
  (`fact_verification` guard, AGENT_CONTRACT §4) — unrounded/ungrounded numeric claims
  are stripped before the bytes leave the process, never rendered;
* foreign `previous_intent` shapes (e.g. the web mock's `near_me`) are alias-mapped to
  our §7.1 enums and re-validated; if still invalid we fall back to fresh extraction
  instead of answering with a half-trusted intent object.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from pydantic import ValidationError

from nexus_ai.api import runs
from nexus_ai.api.deps import Deps
from nexus_ai.contract import Intent
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.router import BudgetExceeded, CostMeter
from nexus_ai.nlu.state_merger import merge_turn, question_for
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.cards import drop_ungrounded_reasons
from nexus_ai.search.service import SearchPlan, plan_from_intent
from nexus_ai.search.service import search as deterministic_search
from nexus_ai.trust.facts import FactBundle
from nexus_ai.trust.verification import verify_generated_text

log = logging.getLogger("nexus_ai.api.pipeline")

#: shapes other NEXUS components legitimately carry (web mock uses `near_me`/`none`)
_LOCATION_TYPE_ALIASES = {"near_me": "nearby", "neighbourhood": "nearby"}
_TIME_TYPE_ALIASES = {"none": "unspecified", "relative_range": "range"}

# D470: the cap moved to the contract module - it is a shape rule, and the
# contract module is where the shapes live (the pipeline still exposes it,
# and the tests pin it here).
from nexus_ai.contract import MAX_QUERY_LENGTH  # noqa: E402,F401


# --------------------------------------------------------------------------- intent
@dataclass
class IntentResult:
    intent: Intent
    provider: str = "mock"
    degraded: bool = True
    note: str | None = None
    changes: list[dict[str, Any]] = field(default_factory=list)
    follow_up_question: str | None = None
    #: D437: what the model layer measured (tokens, cost). The `agent_runs` row carries
    #: tokens and cost_usd (AGENT_CONTRACT §8), and they used to be zeros whatever the
    #: model layer had measured.
    usage: dict[str, Any] = field(default_factory=dict)
    #: D437: the calls themselves, for the cost ledger. `llm_calls.agent_run_id` refers
    #: to `agent_runs(id)`, so the ledger row can only be written AFTER the run row -
    #: the recorder that owns the run writes both, in that order.
    llm_records: list[Any] = field(default_factory=list)


def _alias_intent_shape(data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data)
    loc = out.get("location")
    if isinstance(loc, dict) and loc.get("type") in _LOCATION_TYPE_ALIASES:
        loc = {**loc, "type": _LOCATION_TYPE_ALIASES[loc["type"]]}
        out["location"] = loc
    t = out.get("time")
    if isinstance(t, dict) and t.get("type") in _TIME_TYPE_ALIASES:
        t = {**t, "type": _TIME_TYPE_ALIASES[t["type"]]}
        out["time"] = t
    return out


def validate_intent(data: Any) -> Intent | None:
    if not isinstance(data, dict):
        return None
    for candidate in (_alias_intent_shape(data), data):
        try:
            return Intent.model_validate(candidate)
        except ValidationError:
            continue
    return None


async def understand(query: str, *, deps: Deps, context: dict[str, Any] | None = None,
                     previous_intent: dict[str, Any] | None = None,
                     agent_run_id: Any = None) -> IntentResult:
    """Intent for one turn: model layer first (§9 `intent_extract`), rule floor always."""
    context = dict(context or {})
    deterministic: IntentResult | None = None

    def floor(note: str) -> IntentResult:
        nonlocal deterministic
        if deterministic is None:
            intent = validate_intent(extract_intent_dict(query, context)) \
                or Intent(raw_query=query)
            deterministic = IntentResult(
                intent=intent,
                provider="rules", degraded=True, note=note,
                # D439: §8's one follow-up question, in the user's language.
                follow_up_question=question_for(intent.model_dump()))
        return deterministic

    try:
        if previous_intent:
            merged = merge_turn(previous_intent, query, context)
            intent = validate_intent(merged.intent)
            if intent is not None:
                return IntentResult(intent=intent, provider="rules", degraded=True,
                                    note="state_merge", changes=merged.changes,
                                    follow_up_question=merged.follow_up_question)
            return floor("state_merge_rejected")

        router = deps.router()
        meter = CostMeter()
        call = await router.run(LLMRequest(
            task_class="intent_extract",
            payload={"query": query, "context": context}), meter=meter)
        # D437: the cost ledger is one row per model call (§160) - the row the router
        # builds. The run row has to exist first (`llm_calls.agent_run_id` refers to it),
        # so the recorder that owns the run writes both, in that order.
        data = call.response.data
        if isinstance(data, str):
            import json

            try:
                data = json.loads(data)
            except Exception:
                data = None
        intent = validate_intent(data)
        if intent is None:
            raise ValueError("model returned an Intent outside the §7.1 schema")
        return IntentResult(intent=intent,
                            provider=call.response.provider or router.provider_name(),
                            degraded=bool(meter.degraded), usage=meter.usage(),
                            llm_records=list(meter.records),
                            # D439: §8's one follow-up question, in the user's language.
                            follow_up_question=question_for(intent.model_dump()))
    except BudgetExceeded as exc:
        log.info("intent budget exceeded, deterministic floor: %s", exc)
        return floor("budget_exceeded")
    except Exception as exc:  # any provider failure keeps the deterministic path alive
        log.info("intent model unavailable: %s", exc)
        return floor("model_unavailable")


# --------------------------------------------------------------------------- search
@dataclass
class SearchPack:
    cards: list[Any]
    items: list[dict[str, Any]]
    response: Any  # SearchResponse
    bundle: FactBundle
    scored: list[Any]
    plan: SearchPlan
    set_id: str
    degraded: bool
    vector_lane: bool


async def run_search(deps: Deps, intent: Intent | None, *, query: str = "",
                     geo: Any = None, filters: Any = None, now: datetime | None = None,
                     limit: int = 8, locale: str = "zh-HK",
                     user_id: Any = None) -> SearchPack:
    plan = plan_from_intent(intent, query=(query or (intent.raw_query if intent else "")),
                            geo=geo, filters=filters, now=now, limit=limit, locale=locale)
    backend = deps.backend()
    vector_lane = False
    embedding: list[float] | None = None
    if plan.query_text and deps.settings.embedding_provider == "hashing":
        try:  # hashing embeddings are offline; they only feed the pgvector lane in live DB
            embedding = (await deps.embeddings().embed([plan.query_text]))[0]
        except Exception:  # pragma: no cover - the keyword lane is the floor
            embedding = None
    vector_lane = bool(embedding) and backend.name == "postgres"
    # `search()` matches preferences by key, so it takes them as plain dicts; the contract hands
    # out PreferenceItem models, and calling `.get` on one crashed every query that had a preference.
    intent_prefs = [p.model_dump() for p in intent.preferences] if intent else None
    cards, response, bundle, scored = await deterministic_search(
        backend=backend, plan=plan, tenant_id=deps.tenant_id(),
        embedding=embedding if vector_lane else None, vector_lane=vector_lane,
        user_id=str(user_id) if user_id else None,
        intent_preferences=intent_prefs, locale=locale)
    degraded = deps.backend_degraded() or response.degraded
    # D502: the §18/§19 grounding boundary - a bullet without a `fact_id` must not render
    # (AGENT_CONTRACT §4) - is enforced HERE, in the one function every card surface
    # calls. It used to be enforced only in the recommend route, so the search route (the
    # main consumer surface, and the §105 fallback the stream degrades to) and the stream
    # route shipped cards without it. A boundary that only one surface keeps is a boundary
    # that the other surfaces do not have.
    for card in cards:
        _card, dropped = drop_ungrounded_reasons(card)
        if dropped:  # pragma: no cover - the rules path never emits one
            log.warning("dropped %d ungrounded non-sponsored reason(s)", dropped)
    return SearchPack(cards=cards,
                      items=[c.model_dump(mode="json") for c in cards],
                      response=response, bundle=bundle, scored=scored, plan=plan,
                      set_id=runs.new_id(), degraded=degraded, vector_lane=vector_lane)


# --------------------------------------------------------------------------- summary
@dataclass
class SummaryResult:
    text: str
    citations: list[str]
    provider: str
    degraded: bool
    verification: dict[str, Any] = field(default_factory=dict)
    #: D437: what the summary's model call measured.
    usage: dict[str, Any] = field(default_factory=dict)
    #: D437: the call itself, for the cost ledger (written after the run row).
    llm_records: list[Any] = field(default_factory=list)


def card_citations(items: list[dict[str, Any]], per_card: int = 2) -> list[str]:
    out: list[str] = []
    for item in items:
        for fact in (item.get("facts") or [])[:per_card]:
            fid = fact.get("fact_id")
            if fid and fid not in out:
                out.append(str(fid))
    return out


async def compose_summary(deps: Deps, pack: SearchPack, *,
                          locale: str, agent_run_id: Any = None) -> SummaryResult:
    """User-facing summary text, always post-verified against the grounding bundle (§4)."""
    citations = card_citations(pack.items)
    try:
        router = deps.router()
        meter = CostMeter()
        call = await router.run(LLMRequest(
            task_class="summary",
            payload={"records": pack.items, "locale": locale}), meter=meter)
        # D437: the summary's model call is a row in the cost ledger too - written after
        # the run row, because the ledger row refers to it.
        raw = call.response.text or ""
        report = verify_generated_text(raw, pack.bundle, records=pack.items)
        return SummaryResult(
            text=report.text, citations=citations,
            provider=call.response.provider, degraded=bool(meter.degraded) or pack.degraded,
            verification=report.as_dict(), usage=meter.usage(),
            llm_records=list(meter.records))
    except Exception as exc:
        log.info("summary model unavailable, template floor: %s", exc)
        from nexus_ai.models.mock import SUMMARY_TEMPLATES
        from nexus_ai.models.base import norm_locale

        t = SUMMARY_TEMPLATES[norm_locale(locale)]
        text = (t["found"].format(n=len(pack.items)) if pack.items else t["empty"])
        return SummaryResult(text=text, citations=citations, provider="rules",
                             degraded=True,
                             verification={"note": "model_unavailable_template_floor"})
