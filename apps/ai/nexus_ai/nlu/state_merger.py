"""Follow-up / conversation-state merging — API_CONTRACT §7.1, spec §34.

The contract fixes the semantics: "太贵了" shrinks `budget.max` by 30%, "近一点" switches
sort to distance and tightens the radius, "不吃辣" appends a constraint. Merging is
*pure and ordered* so it unit-tests without a model, and every change is recorded so an
`agent_run` can explain what turn three did to the filters.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from nexus_ai.contract import Intent
from nexus_ai.nlu.understand import IntentExtraction, extract_intent
from nexus_ai.models.base import norm_locale

#: §7.1 — "太贵了" ⇒ budget.max *= 0.7
CHEAP_FACTOR = 0.7
PRICE_UP_FACTOR = 1.4
RADIUS_TIGHTEN = 0.5
RADIUS_LOOSEN = 2.0
DEFAULT_NEARBY_RADIUS_M = 2000
MIN_RADIUS_M = 300
MAX_RADIUS_M = 15000

CHEAPER_CUES = ("太贵", "太貴", "貴啲", "平啲", "平D", "平些", "平一啲", "cheap", "cheaper",
                "too expensive", "too pricey", "太 expensive", "贵了", "貴了", "抵啲", "划算",
                "划算", "price down", "预算少啲", "預算少啲")
PRICIER_CUES = ("貴一啲", "贵一点", "贵啲", "高档", "高級", "高级", "premium", "luxury",
                "expensive", "貴無所謂", "舍得", "budget up", "flagship")
NEARER_CUES = ("近啲", "近一点", "近一啲", "太遠", "太远", "far", "nearest", "closer",
               "near by", "行少两步", "foot", "少啲路")
FARTHER_CUES = ("遠啲", "远一点", "远啲", "扩大范围", "擴大範圍", "farther", "further",
                "wider", "埋遠啲", "更大範圍")
PARTY_CUES = ("我哋", "我们")
QUIET_CUES = ("安靜", "安静", "静啲", "静一啲", "quiet", "唔想太嘈", "不想太吵")
LOUDP_CUES = ("熱鬧", "热闹", "lively")
RESET_CUES = ("重新", "清空", "reset", "start over", "唔係", "不是呢個", "不是这个")
ALT_CUES = ("換一間", "换一间", "其他", "再搵", "再找", "其他选择", "next", "another",
            "more options", "仲有", "还有")
COMPARE_TOP_CUES = ("前三", "頭三位", "头三位", "top 3", "top three", "compare", "比較", "比较")
OPEN_NOW_CUES = ("而家", "现在", "開唔開", "营业吗", "營業嗎", "open now", "still open", "now")
ANYTIME_CUES = ("得閒", "得闲", "anytime", "隨時", "随时", "无所谓", "無所謂")

SPICY = "spicy"


def _canonicalise_cues() -> None:
    """Put the cue lists in the canonical spelling (D421).

    They are written in mixed forms - 近一点 but not 近一點, 熱鬧 and 热闹 but not the
    Traditional 換一間 - and the turn is compared with them in the canonical form, so a
    cue that is only written in the other spelling would never match.
    """
    from nexus_ai.nlu.canonical import canonical

    for name, cues in list(globals().items()):
        if name.endswith("_CUES") and isinstance(cues, tuple):
            globals()[name] = tuple(canonical(cue) for cue in cues)


_canonicalise_cues()


@dataclass
class MergeResult:
    intent: dict[str, Any]
    changes: list[dict[str, Any]] = field(default_factory=list)
    follow_up_question: str | None = None
    is_followup_only: bool = False

    def as_intent_model(self) -> Intent:
        return Intent.model_validate(self.intent)


def merge_turn(state: dict[str, Any] | Intent | None, followup: str,
               context: dict[str, Any] | None = None) -> MergeResult:
    """Apply one user turn onto the carried Intent state (§34)."""
    context = context or {}
    base = _as_dict(state)
    turn = (followup or "").strip()
    if not turn:
        return MergeResult(intent=base, changes=[], is_followup_only=True)

    # D421: the user's words are kept (the raw_query shows what they wrote), and the
    # MATCHING sees the canonical spelling - the same one the cue lists are written in.
    # Without this, a Traditional "近一點" matched no cue at all while the Simplified
    # "近一点" did, and 點 was even read as a time cue.
    from nexus_ai.nlu.canonical import canonical

    match_text = canonical(turn)

    # A turn that carries brand-new structured content wins; the merge rules below are
    # for short anaphoric follow-ups only.
    if _is_cold_start(base) or len(match_text) > 24 and _carries_new_filters(match_text):
        fresh = extract_intent(match_text, {**context, "locale": context.get("locale")
                                                      or base.get("language")}).to_dict()
        fresh["raw_query"] = turn  # the user's own words
        merged = _overlay(fresh, base, turn)
        reset_changes = [{"op": "re_extract", "field": "intent",
                         "value": merged.get("intent")}]
        return MergeResult(intent=merged, changes=reset_changes,
                           follow_up_question=question_for(merged))

    changes: list[dict[str, Any]] = []
    low = match_text.lower()
    locale = norm_locale(str(context.get("locale") or base.get("language") or "zh-HK"))

    # ---- price ----------------------------------------------------------
    if _any(low, match_text, CHEAPER_CUES):
        changes.append(_adjust_budget(base, CHEAP_FACTOR))
    elif _any(low, match_text, PRICIER_CUES):
        changes.append(_adjust_budget(base, PRICE_UP_FACTOR))

    # ---- distance -------------------------------------------------------
    if _any(low, match_text, NEARER_CUES):
        changes.append(_tighten_radius(base, RADIUS_TIGHTEN))
    elif _any(low, match_text, FARTHER_CUES):
        changes.append(_tighten_radius(base, RADIUS_LOOSEN))

    # ---- party size -----------------------------------------------------
    m = re.search(r"(\d{1,2})\s*(?:個|个|位|人|pax|people|persons?)", match_text)
    m = m or re.search(r"(?:party(?:\s*of)?|for)\s*(\d{1,2})\b", low)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 40:
            changes.append({"op": "set", "field": "party_size", "from": base.get("party_size"),
                            "to": n})
            base["party_size"] = n
            _drop_unknown(base, "party_size")

    # ---- spicy / dietary -----------------------------------------------
    if re.search(r"(唔食|不吃|不要|別|别|避免|no|without|avoid|少)\s*(?:食|吃|嘅)?\s*辣", match_text) \
            or re.search(r"no\s+spicy|not\s+spicy", low):
        changes.append(_add_constraint(base, "cuisine_avoid", SPICY))
    elif re.search(r"(唔食|不吃|不要|避免|no|without)\s*(?:食|吃)?\s*(豬|猪|pork|牛|beef|海鮮|海鲜|香菜|花生|奶|dairy|gluten)",
                   turn):
        v = re.search(r"(豬|猪|pork|牛|beef|海鮮|海鲜|香菜|花生|奶|dairy|gluten)", turn)
        if v:
            changes.append(_add_constraint(base, "diet_avoid", v.group(1)))
    elif re.search(r"(辣都可以|辣都ok|spicy ok|无所谓|無所謂|incoming)", match_text):
        changes.append(_drop_constraint(base, SPICY))

    # ---- ambience -------------------------------------------------------
    if _any(low, match_text, QUIET_CUES):
        changes.append(_set_preference(base, "ambience", "quiet", 1))
    elif _any(low, match_text, LOUDP_CUES):
        changes.append(_set_preference(base, "ambience", "lively", 1))

    # ---- urgency / open now --------------------------------------------
    if _any(low, match_text, OPEN_NOW_CUES):
        base["urgency"] = "now"
        changes.append({"op": "set", "field": "urgency", "from": None, "to": "now"})
    elif _any(low, match_text, ANYTIME_CUES):
        base["urgency"] = "flexible"
        changes.append({"op": "set", "field": "urgency", "from": None, "to": "flexible"})

    # ---- compare the top N ---------------------------------------------
    if _any(low, match_text, COMPARE_TOP_CUES):
        targets = [t for t in (context.get("top_subjects") or []) if t][:3]
        base["intent"] = "compare"
        base["mentioned_entities"] = [str(t) for t in targets]
        changes.append({"op": "set", "field": "intent", "from": None, "to": "compare"})

    # ---- "show me others" ----------------------------------------------
    if _any(low, match_text, ALT_CUES):
        seen = [str(s) for s in (context.get("shown_ids") or []) if str(s)]
        filters = base.setdefault("filters", {})
        if isinstance(filters, dict) and seen:
            filters["exclude"] = sorted(set([*(filters.get("exclude") or []), *seen]))
            changes.append({"op": "exclude", "field": "filters.exclude", "to": len(seen)})

    # ---- any remaining explicit content in the follow-up ---------------
    residual = extract_intent(match_text, {**context, "locale": locale})
    changes.extend(_absorb(base, residual, turn))

    if _any(low, match_text, RESET_CUES):
        cleared = extract_intent(match_text, context).to_dict()
        return MergeResult(intent=cleared,
                           changes=[{"op": "reset", "field": "state", "to": "cleared"}],
                           follow_up_question=question_for(cleared), is_followup_only=True)

    base["raw_query"] = f"{base.get('raw_query', '')} · {turn}".strip(" ·")
    _recalc_unknowns(base)
    return MergeResult(intent=base, changes=[c for c in changes if c],
                       follow_up_question=question_for(base), is_followup_only=True)


#: convenience alias — the contract names the merge entry point both ways in docs
merge_followup = merge_turn


# --------------------------------------------------------------------------- internals
def _as_dict(state: dict[str, Any] | Intent | None) -> dict[str, Any]:
    if isinstance(state, Intent):
        return state.model_dump(mode="json")
    if isinstance(state, dict) and state:
        data = dict(state)
        data.setdefault("raw_query", "")
        data.setdefault("intent", "unknown")
        data.setdefault("location", {})
        data.setdefault("time", {})
        data.setdefault("preferences", [])
        data.setdefault("constraints", [])
        data.setdefault("unknowns", [])
        data.setdefault("confidence", {})
        return data
    return IntentExtraction(raw_query="").to_dict()


def _is_cold_start(base: dict[str, Any]) -> bool:
    return base.get("intent") in (None, "", "unknown") and not base.get("category")


def _carries_new_filters(turn: str) -> bool:
    return bool(re.search(r"(預算|预算|budget|HK\$|hk\$|附近|餐厅|餐廳|酒店|健身房|區|区|喺|在)", turn))


def _overlay(fresh: dict[str, Any], base: dict[str, Any], turn: str) -> dict[str, Any]:
    """Keep memory that the new turn did not contradict (§34)."""
    out = dict(fresh)
    for key in ("party_size",):
        if out.get(key) is None and base.get(key) is not None:
            out[key] = base[key]
    if not out.get("location") and base.get("location"):
        out["location"] = base["location"]
    if not out.get("budget") and base.get("budget"):
        out["budget"] = base["budget"]
    if not out.get("constraints") and base.get("constraints"):
        out["constraints"] = base["constraints"]
    if not out.get("preferences") and base.get("preferences"):
        out["preferences"] = base["preferences"]
    if out.get("intent") == "unknown" and base.get("intent") not in (None, "unknown"):
        out["intent"] = base["intent"]
    out["raw_query"] = f"{base.get('raw_query', '')} · {turn}".strip(" ·")
    return out


def _any(low: str, text: str, cues: tuple[str, ...]) -> bool:
    return any(c in text or c.lower() in low for c in cues)


def _adjust_budget(base: dict[str, Any], factor: float) -> dict[str, Any]:
    budget = base.get("budget") or {}
    cur = budget.get("max")
    if cur is None:
        # §8 forbids inventing a number, but "太贵了" still has an honest effect: order by price.
        # This is the same fallback `_tighten_radius` uses when there is no radius to scale.
        base["sort_preference"] = "price_low"
        return {"op": "budget_relative", "field": "budget.max", "factor": factor,
                "applied": False, "sort_preference": "price_low",
                "note": "no stated budget to scale — do not invent one (§8), sort by price instead"}
    new = round(float(cur) * factor, 0)
    budget = {**budget, "max": new}
    base["budget"] = budget
    conf = base.setdefault("confidence", {})
    conf["budget"] = max(float(conf.get("budget") or 0.0), 0.85)
    _drop_unknown(base, "budget")
    return {"op": "scale", "field": "budget.max", "from": cur, "to": new, "factor": factor}


def _tighten_radius(base: dict[str, Any], factor: float) -> dict[str, Any]:
    loc = dict(base.get("location") or {})
    cur = loc.get("radius_m")
    if cur is None:
        cur = DEFAULT_NEARBY_RADIUS_M if loc else None
        if cur is None:
            # no geo anchor: switch the sort, but never invent a radius (§8)
            base["sort_preference"] = "distance" if factor < 1 else base.get("sort_preference")
            loc["type"] = loc.get("type") or "nearby"
            base["location"] = loc
            return {"op": "set", "field": "sort_preference", "to": "distance",
                    "radius_applied": False}
    new = int(max(MIN_RADIUS_M, min(MAX_RADIUS_M, round(float(cur) * factor))))
    loc["radius_m"] = new
    if factor < 1:
        base["sort_preference"] = "distance"
    base["location"] = loc
    conf = base.setdefault("confidence", {})
    conf["location"] = max(float(conf.get("location") or 0.0), 0.8)
    return {"op": "scale", "field": "location.radius_m", "from": cur, "to": new,
            "factor": factor}


def _add_constraint(base: dict[str, Any], key: str, value: str) -> dict[str, Any]:
    cons = list(base.get("constraints") or [])
    if any(c.get("key") == key and c.get("value") == value for c in cons):
        return {"op": "noop", "field": "constraints", "value": f"{key}={value}"}
    cons.append({"key": key, "value": value})
    base["constraints"] = cons
    prefs = [p for p in base.get("preferences") or []
             if not (p.get("value") == value and p.get("polarity", 1) > 0)]
    base["preferences"] = prefs
    return {"op": "append", "field": "constraints", "to": f"{key}={value}"}


def _drop_constraint(base: dict[str, Any], value: str) -> dict[str, Any]:
    cons = [c for c in base.get("constraints") or [] if c.get("value") != value]
    changed = len(cons) != len(base.get("constraints") or [])
    base["constraints"] = cons
    return {"op": "remove", "field": "constraints", "value": value, "applied": changed}


def _set_preference(base: dict[str, Any], key: str, value: str, polarity: int) -> dict[str, Any]:
    prefs = [p for p in base.get("preferences") or [] if p.get("key") != key]
    prefs.append({"key": key, "value": value, "polarity": polarity})
    base["preferences"] = prefs
    conf = base.setdefault("confidence", {})
    conf[f"preference:{key}"] = 0.85
    return {"op": "set", "field": f"preferences.{key}", "to": value}


def _absorb(base: dict[str, Any], turn: IntentExtraction, text: str) -> list[dict[str, Any]]:
    """Pull in whatever the follow-up *did* resolve (a new district, a time, a cuisine)."""
    out: list[dict[str, Any]] = []
    if turn.time and turn.confidence.get("time", 0) >= 0.5:
        base["time"] = turn.time
        base.setdefault("confidence", {})["time"] = turn.confidence["time"]
        out.append({"op": "set", "field": "time", "to": turn.time.get("raw") or text})
    if turn.location and turn.location.get("value"):
        base["location"] = turn.location
        base.setdefault("confidence", {})["location"] = turn.confidence.get("location", 0.8)
        out.append({"op": "set", "field": "location", "to": turn.location.get("value")})
    if turn.category and not base.get("category"):
        base["category"] = turn.category
        out.append({"op": "set", "field": "category", "to": turn.category})
    elif turn.category and turn.confidence.get("category", 0) >= 0.9:
        if turn.category != base.get("category"):
            out.append({"op": "set", "field": "category", "from": base.get("category"),
                        "to": turn.category})
            base["category"] = turn.category
    for p in turn.preferences:
        if p["key"] not in {q.get("key") for q in base.get("preferences") or []}:
            base.setdefault("preferences", []).append(p)
            out.append({"op": "append", "field": "preferences", "to": f"{p['key']}={p['value']}"})
    for c in turn.constraints:
        o = _add_constraint(base, c["key"], c["value"])
        if o.get("op") != "noop":
            out.append(o)
    if turn.budget and not base.get("budget"):
        base["budget"] = turn.budget
        out.append({"op": "set", "field": "budget", "to": turn.budget.get("max")})
    if turn.party_size is not None and base.get("party_size") is None:
        base["party_size"] = turn.party_size
        out.append({"op": "set", "field": "party_size", "to": turn.party_size})
    if turn.mentioned_entities:
        base["mentioned_entities"] = turn.mentioned_entities
        out.append({"op": "set", "field": "mentioned_entities",
                    "to": len(turn.mentioned_entities)})
    if turn.sort_preference != "relevance" and base.get("sort_preference") == "relevance":
        base["sort_preference"] = turn.sort_preference
        out.append({"op": "set", "field": "sort_preference", "to": turn.sort_preference})
    return out


def _drop_unknown(base: dict[str, Any], field_name: str) -> None:
    base["unknowns"] = [u for u in base.get("unknowns") or [] if u != field_name]


def _recalc_unknowns(base: dict[str, Any]) -> None:
    """Reuse the extractor's §8 rule so state and fresh turns agree."""
    ex = IntentExtraction(raw_query=base.get("raw_query", ""))
    ex.intent = base.get("intent") or "unknown"
    ex.category = base.get("category")
    ex.location = base.get("location") or {}
    ex.party_size = base.get("party_size")
    ex.time = base.get("time") or {}
    ex.mentioned_entities = base.get("mentioned_entities") or []
    base["unknowns"] = _compute_unknowns_public(ex)


def _compute_unknowns_public(ex: IntentExtraction) -> list[str]:
    from nexus_ai.nlu.understand import _compute_unknowns

    return _compute_unknowns(ex)


_ONE_FOLLOWUP_ORDER = ("party_size", "time", "location", "budget", "category")


def question_for(intent: dict[str, Any]) -> str | None:
    """§8: ask about the single most important missing thing, in the user's language.

    Exactly one follow-up, never an interrogation.

    D439: this is the question the AGENT CONTRACT asks for, and it was computed here and
    delivered nowhere - the understand endpoint's `follow_up_question` was always null
    because only the merge path ever asked for it. It is public now because every turn
    needs it, not only the ones that follow another turn.
    """
    unknowns = [u for u in intent.get("unknowns") or [] if u in _ONE_FOLLOWUP_ORDER]
    if not unknowns:
        return None
    key = unknowns[0]
    locale = norm_locale(str(intent.get("language") or "zh-HK"))
    bank = {
        "zh-HK": {"party_size": "请问几位？", "time": "想约什么时候？",
                  "location": "想喺边个区？", "budget": "預算大概幾多？",
                  "category": "想食定想買？"},
        "zh-CN": {"party_size": "请问几位？", "time": "想约什么时候？",
                  "location": "想在哪个区？", "budget": "预算大概多少？",
                  "category": "想找餐厅还是商品？"},
        "en": {"party_size": "How many people?", "time": "When would you like to go?",
               "location": "Which area?", "budget": "What's your budget?",
               "category": "Looking for a place or a product?"},
    }
    return bank[locale].get(key)


def session_state_from_context(context: dict[str, Any]) -> dict[str, Any] | None:
    """Read carried state out of `conversations.state` (§34) if the caller sent one."""
    state = context.get("state") or context.get("intent_state")
    if isinstance(state, dict) and state:
        return _as_dict(state)
    return None


def now_in_hk() -> datetime:
    from nexus_ai.nlu.timeparse import HK_TZ

    return datetime.now(HK_TZ)
