"""D1451 — the insights analyst StateGraph: measure → forecast → measures → verify.

The /insights page renders a deterministic replay of ghost readers (no accounts, no tracking).
The narrative lane phrases it in one paragraph. This is the SECOND consumer of the same numbers:
a three-node analyst pipeline that (a) measures the replay with deterministic code, (b) lets the
model project the next seven days standing on those measurements, (c) lets the model propose at
most three next-step optimisation measures, each tied to one measured number, and (d) fences
every model byte — a URL, a digit the replay never carried, a wrong-language draft or an empty
payload all collapse to the deterministic fallback, exactly like the world guide.

Two model calls, never more. Budget: task_class `summary`, temperature 0, json_hint json_object.
The model sees ONLY the measured snapshot (+, for the measures node, the validated forecast).
"""
from __future__ import annotations

import re
from typing import Any, Awaitable, Callable, TypedDict

import logging

from langgraph.graph import END, StateGraph

log = logging.getLogger("nexus_ai.orchestrator.insights_analyst_graph")

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_DIGIT_RE = re.compile(r"\d+")
#: structural digits the model may use for shape ("3 actions", "24 hours"), never as data —
#: the exact small set the admin lane has used since D-admin (see routes_admin._STRUCTURAL_OK)
_STRUCTURAL_OK = {str(n) for n in range(0, 11)} | {"24", "100", "2026"}

_FORECAST_SYSTEM = """You are the NEXUS operations-desk analyst. You are given ONE measured snapshot of a deterministic week of ghost reader replay — never pretend these are real people, and never claim otherwise.
Return JSON only: {"forecast": "<ONE sentence, at most 200 characters, in the payload's locale: what the next seven days look like if NOTHING changes, ending by naming the single variable to watch>", "watch": "<one short clause naming that watched variable>", "confidence": "low|medium|high"}.
Hard rules:
- Every number you write MUST appear in the measured snapshot. If you want to write a number that is not there, STOP talking about it instead.
- Never invent a metric, a user, a merchant, a street, a city, a percentage or a magnitude that is not visibly implied by the snapshot.
- If the slope is flat (|slope| <= 0.5), the sentence MUST read as "the week is flat — do nothing bold", not as a warning.
- No URLs, no markdown, no code fences, no bold, no tables. JSON only.
"""

_MEASURES_SYSTEM = """You are the NEXUS operations-desk strategist. You are given ONE measured snapshot of a deterministic week of ghost reader replay and a forecast about the SAME replay.
Return JSON only: {"measures": [{"action": "<one imperative, at most 110 characters, in the payload's locale>", "why": "<the ONE measured number this measure answers to, at most 110 characters>"}], "confidence": "low|medium|high"}.
Hard rules:
- At most THREE measures. One measure per surface (first screen, copy, empty state, CTA, search, rails).
- Never invent a metric. Every number you write MUST appear in the snapshot or the forecast.
- Prefer structural fixes (scope, copy, order, emptiness) over "launch a campaign".
- If the slope is flat, the FIRST measure must say to leave the funnel alone.
- No URLs, no markdown, no code fences, no bold, no tables. JSON only.
"""

_FORECAST_FALLBACK = {
    "en": "The week this replay measured reads {verdict} (slope {slope}); average drop-off {avg}%. Watch the worst day ({worst_day}) — if it drifts, that line moved, not the whole product.",
    "zh-HK": "呢條重放量到嘅球段：{verdict}（斜率 {slope}），平均流失 {avg}%。盯住最高流失嗰日（{worst_day}）——條線動，說明是嗰部分而唔係成個產品。",
    "zh-CN": "这条重放量到的球段：{verdict}（斜率 {slope}），平均流失 {avg}%。盯住流失最高的那天（{worst_day}）——单一那条线动，说明是那部分的问题而不是整个产品。",
}
_WATCH_FALLBACK = {
    "en": "the worst-day drop-off",
    "zh-HK": "最高流失嗰日嘅掉拍率",
    "zh-CN": "流失最高那天的掉拍率",
}
_MEASURES_FALLBACK = [
    {
        "action": {
            "en": "Cap the first screen at three calls-to-action; push everything else one tap deeper.",
            "zh-HK": "首屏只留三個行動按鈕，其餘一層深入再出現。",
            "zh-CN": "首屏只留三个行动按钮，其余再深一层才出现。",
        },
        "why": {
            "en": "Worst-day drop-off was {worst_drop}% on {worst_day} — the landing is doing the teaching, not the product.",
            "zh-HK": "最高流失日（{worst_day}）到 {worst_drop}%——係首屏落門檻，唔係產品本身。",
            "zh-CN": "流失最高那天（{worst_day}）到 {worst_drop}%——是首屏门槛太高，不是产品本身的问题。",
        },
    },
    {
        "action": {
            "en": "Add one \"why to read\" line above every rail before any card ships.",
            "zh-HK": "每條 rail 上卡之前，先寫一句「為何讀」。",
            "zh-CN": "每条 rail 上卡之前，先写一句\"为何读\"。",
        },
        "why": {
            "en": "The dominant archetype was {dominant} — the window shopper stops for a reason, never for another number.",
            "zh-HK": "最多人係「{dominant}」——漫遊者只為一個理由先肯停，唔會為多一個數字停。",
            "zh-CN": "最多人是\"{dominant}\"——漫游者只为一个理由才停，不会为多一个数字停。",
        },
    },
    {
        "action": {
            "en": "Anchor the first CTA to the busiest hour of the ramp; stay quiet at the dead hours.",
            "zh-HK": "將首個 CTA 對齊每小時人流嘅高位，冷落時段收聲。",
            "zh-CN": "把首个 CTA 对齐每小时人流的高位，冷落时段不要硬推。",
        },
        "why": {
            "en": "The arrival ramp peaks at hour {peak_hour} — the CTA should meet the crowd, not the empty room.",
            "zh-HK": "進場高峰在第 {peak_hour} 小時——CTA 要迎人，唔係迎空房。",
            "zh-CN": "进场高峰在第 {peak_hour} 小时——CTA 要迎人，不是迎空房。",
        },
    },
]


def _locale_of(locale: str) -> str:
    loc = (locale or "").strip().lower().replace("_", "-")
    if loc.startswith("en"):
        return "en"
    if loc.startswith("zh-cn") or loc.startswith("zh-sg") or loc.startswith("zh-hans"):
        return "zh-CN"
    return "zh-HK"


def _walk_numbers(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        for v in node.values():
            _walk_numbers(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk_numbers(v, out)
    elif isinstance(node, bool):
        out.add("1" if node else "0")
    elif isinstance(node, (int, float)):
        out.add(str(node))
        if float(node).is_integer():
            out.add(f"{float(node):.0f}")
    elif isinstance(node, str):
        out.update(_DIGIT_RE.findall(node))


def _allowed_numbers(stats: dict[str, Any], measured: dict[str, Any]) -> set[str]:
    allowed: set[str] = set(_STRUCTURAL_OK)
    _walk_numbers(stats, allowed)
    _walk_numbers(measured, allowed)
    return allowed


def _digit_leak(text: str, allowed: set[str]) -> str | None:
    for m in _DIGIT_RE.finditer(text or ""):
        if m.group(0) not in allowed:
            return m.group(0)
    return None


def _lang_ok(locale: str, text: str) -> bool:
    loc = _locale_of(locale)
    has_cjk = bool(_CJK_RE.search(text))
    if loc == "en":
        return not has_cjk
    return has_cjk


class _AnalystState(TypedDict, total=False):
    locale: str
    stats: dict[str, Any]
    measured: dict[str, Any]
    allowed: set[str]
    verdict: str
    forecast: str
    watch: str
    forecast_confidence: str
    measures: list[dict[str, str]]
    measures_confidence: str
    measures_guard: str
    confidence: str
    source: str
    guard: str
    focus: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _measure_node(state: _AnalystState) -> _AnalystState:
    stats = state.get("stats") or {}
    week = stats.get("week") if isinstance(stats.get("week"), dict) else {}
    points = week.get("points") if isinstance(week.get("points"), list) else []

    def _num(v: Any, default: float = 0.0) -> float:
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    totals = [int(_num(p.get("total"))) for p in points if isinstance(p, dict)]
    drops = [int(_num(p.get("dropRate"))) for p in points if isinstance(p, dict)]
    slope = round(_num(stats.get("slope")), 2)
    if abs(slope) <= 0.5:
        verdict = "flat"
    elif slope > 0.5:
        verdict = "rising"
    else:
        verdict = "falling"

    worst_drop = max(drops) if drops else 0
    worst_day = ""
    worst_date = ""
    for p in points:
        if isinstance(p, dict) and int(_num(p.get("dropRate"))) == worst_drop and not worst_date:
            worst_date = str(p.get("date") or "")
            worst_day = worst_date
    profiles = stats.get("profiles") if isinstance(stats.get("profiles"), list) else []
    dominant = ""
    dominant_count = -1
    for p in profiles:
        if isinstance(p, dict):
            count = int(_num(p.get("count")))
            if count > dominant_count:
                dominant_count = count
                dominant = str(p.get("profile") or "")

    ramp = stats.get("hourRamp") if isinstance(stats.get("hourRamp"), list) else []
    try:
        peak_hour = int(max(range(len(ramp)), key=lambda i: _num(ramp[i]))) if ramp else 0
    except ValueError:
        peak_hour = 0

    avg_drop = round(sum(drops) / len(drops), 1) if drops else 0.0
    measured = {
        "total": int(_num(stats.get("total"))),
        "weeklyTotal": int(_num(week.get("weeklyTotal"))),
        "slope": slope,
        "verdict": verdict,
        "days": len(points),
        "dailyTotals": totals,
        "avgDropRate": avg_drop,
        "worstDay": worst_day,
        "worstDropRate": worst_drop,
        "dominantProfile": dominant,
        "rampPeakHour": peak_hour,
    }
    return {"measured": measured, "verdict": verdict,
            "allowed": _allowed_numbers(stats, measured)}


def _forecast_fallback(locale: str, measured: dict[str, Any]) -> tuple[str, str]:
    loc = _locale_of(locale)
    template = _FORECAST_FALLBACK[loc]
    verdict_label = {"flat": "", "rising": "", "falling": ""}
    if loc == "en":
        verdict_label = {"flat": "flat", "rising": "rising", "falling": "cooling"}[measured["verdict"]]
    elif loc == "zh-CN":
        verdict_label = {"flat": "平盘", "rising": "回暖", "falling": "下滑"}[measured["verdict"]]
    else:
        verdict_label = {"flat": "平盤", "rising": "回暖", "falling": "下滑"}[measured["verdict"]]
    sentence = template.format(
        verdict=verdict_label,
        slope=measured["slope"],
        avg=measured["avgDropRate"],
        worst_day=measured["worstDay"] or ("" if loc != "en" else "the worst day"),
    )
    return sentence, _WATCH_FALLBACK[loc]


def _measures_fallback(locale: str, measured: dict[str, Any]) -> list[dict[str, str]]:
    loc = _locale_of(locale)
    dominant = measured.get("dominantProfile") or ("?" if loc == "en" else "未知")
    worst_day = measured.get("worstDay") or ("?" if loc == "en" else "未知")
    worst_drop = measured.get("worstDropRate", 0)
    peak_hour = measured.get("rampPeakHour", 0)
    out: list[dict[str, str]] = []
    for item in _MEASURES_FALLBACK:
        out.append({
            "action": item["action"][loc].format(),
            "why": item["why"][loc].format(
                worst_drop=worst_drop,
                worst_day=worst_day,
                dominant=dominant,
                peak_hour=peak_hour,
            ),
        })
    return out


async def _forecast_node(state: _AnalystState) -> _AnalystState:
    measured = state.get("measured") or {}
    locale = str(state.get("locale") or "zh-HK")
    llm_call = state.get("llm_call")
    if llm_call is None:
        sentence, watch = _forecast_fallback(locale, measured)
        return {"forecast": sentence, "watch": watch,
                "forecast_confidence": "low", "guard": "no_model"}

    prompt = (
        f"Locale: {locale}\n"
        f"Measured snapshot (deterministic replay of ghost readers — never real people):\n"
        f"{_json_dumps(measured)}\n\n"
        "JSON only."
    )
    try:
        reply = await llm_call(_FORECAST_SYSTEM, prompt, 220)
    except Exception:
        reply = None

    if not isinstance(reply, dict):
        sentence, watch = _forecast_fallback(locale, measured)
        return {"forecast": sentence, "watch": watch,
                "forecast_confidence": "low", "guard": "model_unavailable"}

    return {"forecast": str(reply.get("forecast") or "").strip(),
            "watch": str(reply.get("watch") or "").strip(),
            "forecast_confidence": str(reply.get("confidence") or "low").lower()}


async def _measures_node(state: _AnalystState) -> _AnalystState:
    measured = state.get("measured") or {}
    locale = str(state.get("locale") or "zh-HK")
    forecast = str(state.get("forecast") or "").strip()
    watch = str(state.get("watch") or "").strip()
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"measures": _measures_fallback(locale, measured),
                "measures_confidence": "low",
                "measures_guard": "no_model"}

    prompt = (
        f"Locale: {locale}\n"
        f"Measured snapshot (deterministic replay of ghost readers — never real people):\n"
        f"{_json_dumps(measured)}\n\n"
        f"Validated forecast from the same replay: {forecast}\n"
        f"Watched variable: {watch}\n\n"
        "JSON only."
    )
    try:
        reply = await llm_call(_MEASURES_SYSTEM, prompt, 420)
    except Exception:
        reply = None

    if not isinstance(reply, dict):
        return {"measures": _measures_fallback(locale, measured),
                "measures_confidence": "low",
                "measures_guard": "model_unavailable"}

    raw = reply.get("measures") if isinstance(reply.get("measures"), list) else []
    measures: list[dict[str, str]] = []
    for item in raw[:3]:
        if not isinstance(item, dict):
            continue
        action = str(item.get("action") or "").strip()
        why = str(item.get("why") or "").strip()
        if action and why:
            measures.append({"action": action, "why": why})
    if not measures:
        return {"measures": _measures_fallback(locale, measured),
                "measures_confidence": "low",
                "measures_guard": "no_usable_rows"}
    return {"measures": measures,
            "measures_confidence": str(reply.get("confidence") or "low").lower()}


def _json_dumps(value: Any) -> str:
    import json
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _verify_node(state: _AnalystState) -> _AnalystState:
    locale = str(state.get("locale") or "zh-HK")
    loc = _locale_of(locale)
    allowed = state.get("allowed") or set()
    measured = state.get("measured") or {}
    fallback_used: list[str] = []

    forecast = str(state.get("forecast") or "").strip()
    watch = str(state.get("watch") or "").strip()
    forecast_confidence = str(state.get("forecast_confidence") or "low")
    measures = state.get("measures") or []
    measures_confidence = str(state.get("measures_confidence") or "low")

    def _fence_sentence(text: str, *, cap: int) -> str | None:
        if not text or len(text) > cap:
            return None
        if _URL_RE.search(text):
            return None
        if not _lang_ok(loc, text):
            return None
        if _digit_leak(text, allowed):
            return None
        return text

    # --- forecast fence
    fenced = _fence_sentence(forecast, cap=220)
    if fenced is None:
        fallback_used.append("forecast")
        forecast, watch = _forecast_fallback(locale, measured)
        forecast_confidence = "low"
    # --- watch fence (clause; digits must also belong)
    watch_fenced = _fence_sentence(watch, cap=80) if watch else None
    if watch_fenced is None:
        if "watch" not in fallback_used:
            fallback_used.append("watch")
        watch = _WATCH_FALLBACK[loc]
        forecast_confidence = "low" if forecast_confidence == "low" else forecast_confidence
    else:
        watch = watch_fenced

    # --- measures fence (drop bad rows; keep at most 3)
    clean: list[dict[str, str]] = []
    for item in measures:
        action = _fence_sentence(str(item.get("action") or "").strip(), cap=120)
        why = _fence_sentence(str(item.get("why") or "").strip(), cap=120)
        if action is None or why is None:
            continue
        clean.append({"action": action, "why": why})
    partial_measures = bool(clean) and len(clean) != len(measures)
    if not clean:
        fallback_used.append("measures")
        clean = _measures_fallback(locale, measured)
        measures_confidence = "low"

    node_guards = {g for g in (state.get("guard"), state.get("measures_guard")) if g}
    essential = node_guards | ({"forecast"} & set(fallback_used)) | ({"measures"} & set(fallback_used))
    if essential:
        source = "fallback"
    elif fallback_used or partial_measures:
        # only the watched clause softened, or some measures dropped, none collapsed
        source = "mixed"
    else:
        source = "llm"
    confidence = "medium"
    if "low" in {forecast_confidence, measures_confidence} or fallback_used or node_guards:
        confidence = "low"
    elif forecast_confidence == "high" and measures_confidence == "high":
        confidence = "high"

    out: _AnalystState = {
        "forecast": forecast,
        "watch": watch,
        "measures": clean[:3],
        "source": source,
        "confidence": confidence,
    }
    reported_guards = set(node_guards) | set(fallback_used)
    if reported_guards:
        out["guard"] = "\u002f".join(sorted(reported_guards))
    return out


def build_graph():
    graph = StateGraph(_AnalystState)
    graph.add_node("measure", _measure_node)
    graph.add_node("predict", _forecast_node)
    graph.add_node("prescribe", _measures_node)
    graph.add_node("verify", _verify_node)
    graph.set_entry_point("measure")
    graph.add_edge("measure", "predict")
    graph.add_edge("predict", "prescribe")
    graph.add_edge("prescribe", "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_analyst(*, locale: str, stats: dict[str, Any],
                      llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None,
                      ) -> dict[str, Any]:
    """One turn through the graph. Never raises — the caller always gets an analyst readout."""
    loc = _locale_of(locale)
    fallback = {
        "verdict": "flat",
        "forecast": _forecast_fallback(loc, {"verdict": "flat", "slope": 0.0, "avgDropRate": 0.0,
                                             "worstDay": "", "worstDropRate": 0})[0],
        "watch": _WATCH_FALLBACK[loc],
        "measures": _measures_fallback(loc, {"dominantProfile": "", "worstDay": "",
                                            "worstDropRate": 0, "rampPeakHour": 0}),
        "source": "fallback",
        "confidence": "low",
        "guard": "graph_refused",
    }
    try:
        final = await compiled_graph().ainvoke({
            "locale": locale,
            "stats": stats,
            "llm_call": llm_call,
        })
    except Exception:
        return fallback
    measures = final.get("measures") or []
    return {
        "verdict": str(final.get("verdict") or "flat"),
        "forecast": str(final.get("forecast") or fallback["forecast"]),
        "watch": str(final.get("watch") or fallback["watch"]),
        "measures": list(measures)[:3],
        "source": str(final.get("source") or "fallback"),
        "confidence": str(final.get("confidence") or "low"),
        **({"guard": final["guard"]} if final.get("guard") else {}),
    }
