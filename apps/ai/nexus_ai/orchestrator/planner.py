"""§10's planner: a typed `Plan`, the minimum steps the registry can actually run.

No model decides anything here. The turn is split into clauses (`？`, `?`, `!`, `，`,
`,`, `;`, `：`, newline), and each clause is matched independently against explicit
trigger tables; a clause fires at most one hours, one price, one preferences and one
search rule, in that fixed order. Per-clause evaluation keeps a multi-ask turn from
polluting the search query with an hours clause (`幾點開？同埋搵咖啡` searches for `咖啡`,
never for the whole sentence). Anything the rules cannot resolve is a step the
executor skips with the missing key named — never a guessed argument, never a
fabricated subject.

Budget (§10 rule 2): at most `MAX_STEPS` steps; a turn that fires every rule still fits
the cap, and nothing beyond the cap is planned.

Supported tools (the ones the registry registers today): `get_business_hours`,
`get_price`, `get_user_preferences`, `search_merchants`, `search_products`,
`search_services`. A turn about anything else is refused honestly — an empty plan with
the reason, not an improvisation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

#: §10 rule 2 — default max 6 tool calls per user-facing request. This is the FLOOR/DEFAULT
#: only; the operator's `Settings.max_tool_calls` (env NEXUS_MAX_TOOL_CALLS) is the live cap,
#: threaded in by the API route through `resolve_max_steps`. D1002: before this wiring the knob
#: was parsed from env and then dropped — `MAX_STEPS` won on every request regardless of env.
MAX_STEPS = 6
#: Guard against a nonsensical env value: the cap must stay a positive step budget, never 0/negative
#: (which would silently plan nothing) and never above the registry's declared tool inventory.
MAX_STEPS_CEILING = 64


def resolve_max_steps(settings: Any = None) -> int:
    """D1002 — the ONE reader of the operator's step budget.

    `getattr` keeps the §105 bare-dummy-settings ladders (and direct calls with no settings) working:
    an absent `max_tool_calls` falls back to the §10 rule-2 default (6). A present value is clamped
    to [1, MAX_STEPS_CEILING] so a typo'd env cannot disable planning or explode the step budget.
    """
    raw = getattr(settings, "max_tool_calls", MAX_STEPS) if settings is not None else MAX_STEPS
    try:
        cap = int(raw)
    except (TypeError, ValueError):
        cap = MAX_STEPS
    return max(1, min(cap, MAX_STEPS_CEILING))


_CLAUSE_SPLIT = re.compile(r"[？?！!，,;；:：\n]+")

_HOURS_TRIGGERS = (
    "几点开", "幾點開", "几点关", "幾點關", "几点打烊", "幾點打烊", "打烊", "营业时间", "營業時間",
    "opening hours", "open now", "business hours", "what time", "is it open", "closed now",
    "when does it open", "when does it close", "開門", "開門時間",
)
_PRICE_TRIGGERS = (
    "price", "prices", "cost", "how much", "幾錢", "幾錢啊", "價錢", "價格", "价格", "售价", "售價",
    "多少钱", "多少錢", "几多钱", "幾多錢", "标价", "標價",
)
_PREF_TRIGGERS = (
    "preference", "preferences", "my preference", "my preferences", "偏好", "喜好", "口味",
)
_SEARCH_TRIGGERS = (
    "search", "find", "look for", "looking for", "找一家", "找间", "搵", "搜寻", "搜尋", "搜索",
    "搵下", "寻找", "尋找",
)
_PRODUCT_HINTS = (
    "product", "products", "item", "items", "商品", "产品", "產品", "货品", "貨品",
)
_SERVICE_HINTS = (
    "service", "services", "服务", "服務",
)
#: Connectors that may join two asks in one clause; they are never the search query.
_CONNECTORS = (
    "同埋", "同時", "仲有", "和 ", " 和", "又 ",
)

_QUERY_TRAILING_STOPWORDS = (
    " for me", " pel", " please", " 麻烦", " 謝謝", " 谢谢", " 呀", " 啊", " 呢", " 吧",
)
_LEADING_QUERY_STOPWORDS = (
    "for ", "about ", "的",
)


@dataclass(frozen=True)
class PlannedStep:
    """One typed step. `missing` names the context keys the caller must supply; a step
    with missing keys is planned but the executor skips it — never executed, never
    guessed."""

    tool: str
    args: Mapping[str, Any]
    reason: str
    missing: tuple[str, ...] = ()


@dataclass(frozen=True)
class Plan:
    steps: tuple[PlannedStep, ...] = field(default_factory=tuple)
    refused: str | None = None


def _has_any(lowered: str, triggers: tuple[str, ...]) -> bool:
    return any(t in lowered for t in triggers)


def _query_from(clause: str) -> str:
    """The search query: the clause with every trigger phrase removed (longest first,
    so a plural hint is consumed whole), whitespace collapsed, leading stopwords
    dropped. Empty when the clause carried no query — that is a needs-clarification,
    never a fabricated search term."""
    out = clause
    for trigger in sorted(_SEARCH_TRIGGERS + _PRODUCT_HINTS + _SERVICE_HINTS + _CONNECTORS,
                          key=len, reverse=True):
        out = out.replace(trigger, " ")
    for word in _LEADING_QUERY_STOPWORDS:
        if out.startswith(word):
            out = out[len(word):]
    for tail in _QUERY_TRAILING_STOPWORDS:
        if out.endswith(tail):
            out = out[: -len(tail)]
    return " ".join(out.split()).strip()


def _steps_for_clause(clause: str, ctx: Mapping[str, Any]) -> list[PlannedStep]:
    steps: list[PlannedStep] = []

    # ---- hours (§10 rule 1: a bare "is it open now" is hours, never retrieval) ----
    if _has_any(clause, _HOURS_TRIGGERS):
        merchant_id = ctx.get("merchant_id")
        if merchant_id:
            steps.append(PlannedStep("get_business_hours", {"merchant_id": str(merchant_id)},
                                      "hours trigger"))
        else:
            steps.append(PlannedStep("get_business_hours", {}, "hours trigger",
                                      missing=("merchant_id",)))

    # ---- price ----
    if _has_any(clause, _PRICE_TRIGGERS):
        subject_id = ctx.get("subject_id") or ctx.get("merchant_id")
        subject_type = ctx.get("subject_type") or ("merchant" if ctx.get("merchant_id") else None)
        args = {k: str(v) for k, v in (("subject_id", subject_id),
                                       ("subject_type", subject_type)) if v}
        missing = tuple(k for k in ("subject_id", "subject_type") if k not in args)
        steps.append(PlannedStep("get_price", args, "price trigger", missing=missing))

    # ---- preferences ----
    if _has_any(clause, _PREF_TRIGGERS):
        steps.append(PlannedStep("get_user_preferences", {}, "preferences trigger"))

    # ---- search ----
    if _has_any(clause, _SEARCH_TRIGGERS):
        query = _query_from(clause)
        if _has_any(clause, _PRODUCT_HINTS):
            tool, kind = "search_products", "products"
        elif _has_any(clause, _SERVICE_HINTS):
            tool, kind = "search_services", "services"
        else:
            tool, kind = "search_merchants", "merchants"
        if query:
            steps.append(PlannedStep(tool, {"text": query}, f"search trigger ({kind})"))
        else:
            steps.append(PlannedStep(tool, {}, f"search trigger ({kind})",
                                     missing=("text",)))

    return steps


def plan_tools(text: str, *, context: Mapping[str, Any] | None = None,
               max_steps: int | None = None) -> Plan:
    # D1002: the cap is the operator's live budget when supplied by the route (via
    # resolve_max_steps(settings)), else the §10 rule-2 default. Direct callers and existing tests
    # that omit max_steps keep the exact 6-step behaviour — no silent change to the default plane.
    cap = max_steps if max_steps is not None else MAX_STEPS
    lowered = str(text or "").lower()
    ctx = dict(context or {})
    clauses = [c.strip() for c in _CLAUSE_SPLIT.split(lowered) if c and c.strip()]
    if not clauses:
        clauses = [lowered] if lowered else []

    steps: list[PlannedStep] = []
    for clause in clauses:
        steps.extend(_steps_for_clause(clause, ctx))
        if len(steps) >= cap:
            break

    if not steps:
        return Plan(steps=(), refused="no orchestrator rule matched this turn; "
                                      "nothing was planned — a greeting or an "
                                      "unrecognised request is answered without tools")

    return Plan(steps=tuple(steps[:cap]), refused=None)
