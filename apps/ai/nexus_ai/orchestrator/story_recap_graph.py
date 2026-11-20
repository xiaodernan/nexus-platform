"""D1468 — the story-recap StateGraph: where the 162-chapter arc actually stands.

A reader who opens the world mid-series needs orientation, not spoilers. This graph reads the
frozen arc atlas (chapter number + clock + scene, already shipped as the chapter-lane system
context) and asks the model for one short recap of a requested window, strictly from those atlas
lines. It is a NEW user-reachable lane with an explicit CTA — no background call, no token spent
until the reader asks.

Pipeline (a real StateGraph — `locate` → `recap` → `verify`, refusal short-circuits to END):

- `locate`: selects the requested window of atlas lines (default: the last 12 chapters),
  deterministic, no network; unknown endpoints clamp to the available atlas.
- `recap`: ONE temperature-0 model call; the reply must name only chapters inside the window.
- `verify`: URL-free, length cap, locale glyph sanity, chapter numbers must exist in the window,
  recurring names must keep their canonical English spelling. A refused reply is an empty recap
  with a reason — never a confident fabrication about a world the model has not seen.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

ATLAS = Path(__file__).resolve().parent.parent / "models" / "atlas_index.txt"
_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_NUM_RE = re.compile(r"\b(?:ch(?:apter)?\s*)?(\d{1,3})\b", re.IGNORECASE)
NAME_MAP = {"陳炳": "Chan Bok", "阿樂": "Ah Lok", "阿穆": "Ah Muk", "阿穩": "Ah Wan", "阿游": "Ah Yau"}

_SYSTEM = """You are the recap voice inside the NEXUS Hong Kong arc — a quiet archivist, never a narrator of invented scenes.
You receive ONLY an ordered slice of the real arc atlas (chapter number · clock · scene). Return JSON ONLY:
{"recap": "<at most 260 characters, in the reader's language, naming what THIS window of chapters is about>",
 "watch": "<one short clause, at most 80 characters, naming the thread still open at the end of the window>",
 "confidence": "low|medium|high"}
Hard rules: every chapter number you write MUST come from the supplied slice; do not invent a character, place, event, price or beat; no URLs; if the slice cannot support a sentence, return an empty recap rather than a plausible one.
"""


class _RecapState(TypedDict, total=False):
    locale: str
    start: int
    end: int
    lines: list[str]
    numbers: set[int]
    reply: dict[str, Any]
    clean: dict[str, Any]
    degraded: bool
    reason: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _atlas_lines() -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for line in io.open(ATLAS, encoding="utf-8").read().splitlines():
        m = re.match(r"^\s*(\d{1,3})\s*·\s*(.*)$", line)
        if m:
            out.append((int(m.group(1)), m.group(2).strip()))
    return out


def _locale_of(raw: str) -> str:
    loc = (raw or "").strip().lower().replace("_", "-")
    if loc.startswith("en"):
        return "en"
    return "zh-HK" if not loc.startswith("zh-cn") else "zh-CN"


def _locate_node(state: _RecapState) -> _RecapState:
    all_lines = _atlas_lines()
    if not all_lines:
        return {"degraded": True, "reason": "atlas_unreadable"}
    available = {n for n, _ in all_lines}
    lo = max(1, int(state.get("start") or 0))
    hi = min(max(available), int(state.get("end") or 0))
    if hi < lo:
        last = max(available)
        lo, hi = max(1, last - 11), last
    chosen = [(n, text) for n, text in all_lines if lo <= n <= hi][-12:]
    if not chosen:
        return {"degraded": True, "reason": "empty_window"}
    return {
        "lines": [f"  ch {n} · {text}" for n, text in chosen],
        "numbers": {n for n, _ in chosen},
    }


async def _recap_node(state: _RecapState) -> _RecapState:
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"degraded": True, "reason": "no_model"}
    prompt = (
        f"Locale: {state['locale']}\n"
        f"Window (oldest first):\n" + "\n".join(state.get("lines", [])) + "\n\nJSON only."
    )
    try:
        reply = await llm_call(_SYSTEM, prompt, 420)
    except Exception:
        return {"degraded": True, "reason": "model_unavailable"}
    if not isinstance(reply, dict):
        return {"degraded": True, "reason": "non_json_reply"}
    return {"reply": reply}


def _verify_node(state: _RecapState) -> _RecapState:
    reply = state.get("reply") or {}
    allowed = state.get("numbers") or set()
    loc = _locale_of(state["locale"])

    def text_field(name: str, cap: int) -> str:
        value = reply.get(name)
        if not isinstance(value, str) or not value.strip() or len(value) > cap:
            return ""
        if _URL_RE.search(value):
            return ""
        for m in _NUM_RE.finditer(value):
            n = int(m.group(1))
            if n not in allowed and n not in {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10}:
                return ""
        if loc == "en" and _CJK_RE.search(value):
            return ""
        if loc != "en" and not _CJK_RE.search(value):
            return ""
        return value.strip()

    recap = text_field("recap", 260)
    watch = text_field("watch", 80)
    combined = recap + " " + watch
    if loc == "en":
        for zh, en in NAME_MAP.items():
            if zh in " ".join(state.get("lines", [])) and en.lower() not in combined.lower():
                return {"degraded": True, "reason": f"name_drift:{en}", "clean": {}}
    confidence = reply.get("confidence")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if not recap and not watch:
        return {"degraded": True, "reason": "all_fields_refused", "clean": {}}
    return {"degraded": False, "clean": {"recap": recap, "watch": watch, "confidence": confidence.lower()}}


def build_graph():
    graph = StateGraph(_RecapState)
    graph.add_node("locate", _locate_node)
    graph.add_node("phrase", _recap_node)
    graph.add_node("verify", _verify_node)
    graph.set_entry_point("locate")
    graph.add_conditional_edges("locate", lambda s: END if s.get("degraded") else "phrase")
    graph.add_conditional_edges("phrase", lambda s: END if s.get("degraded") else "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_recap(*, locale: str, start: int, end: int,
                    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None) -> dict[str, Any]:
    """Never raises. A refused recap is an empty artifact with a reason."""
    try:
        final = await compiled_graph().ainvoke({"locale": locale, "start": start, "end": end, "llm_call": llm_call})
    except Exception as exc:
        return {"degraded": True, "reason": f"graph_error:{type(exc).__name__}", "clean": {}}
    if final.get("degraded"):
        return {"degraded": True, "reason": final.get("reason", "refused"), "clean": {}}
    return {"degraded": False, **final["clean"]}
