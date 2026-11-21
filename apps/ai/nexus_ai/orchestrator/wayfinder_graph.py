"""D1479 — the wayfinder StateGraph: LLM-driven reader-state transition, fenced to the real arc.

The arc has 163 chapters in three arms. A reader who has just finished chapter N — or who
arrives cold — does not need a spoiler, they need a *next*. This graph is the smallest honest
machine that turns a reader's state (where they are + how they feel) into a grounded next
chapter, then writes two sentences of content about why. The model does the choosing and the
phrasing; the graph does the reading, the shortlisting and the refusing.

Pipeline: ``locate → shortlist → choose → verify`` — ONE temperature-0 call in `choose`.

- `locate`: clamps the reader's position into 1..ARC_SIZE, decides the layer. No model.
- `shortlist`: reads the frozen atlas index and picks REAL chapters only — the next few after
  the reader's position, plus one earlier chapter when they ask to revisit. Nothing invented;
  an empty shortlist is an honest refusal, never a guessed title.
- `choose`: one JSON call over the shortlist plus the whole-arc digest (the large, byte-stable
  context the shared prefix rides on). The model picks a number from the shortlist and writes
  a reason + a "what to notice" line.
- `verify`: the chosen number MUST be in the shortlist; text must be URL-free, CJK-matched to
  locale and bounded; a fully-refused reply degrades to an empty result with a reason.

Never raises. The operator decides when to spend the call; a mock or failing model is inert.

Why this is a *state transition* and not just another single-shot call: the graph's state IS
the reader's position, and the output is the next position — the same shape as a graph node
moving a token through a workflow. The model is the transition function; `verify` is the guard
that keeps the transition inside the set of states that actually exist in the corpus.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

ROOT = Path(__file__).resolve().parents[3]
INDEX = ROOT / "ai" / "nexus_ai" / "models" / "atlas_index.txt"
DIGEST = ROOT / "ai" / "nexus_ai" / "models" / "atlas_digest.txt"

ARC_SIZE = 163
_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_DIGIT_RE = re.compile(r"\d+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

#: The moods a reader can name. Each maps to a short, deterministic shortlist rule — the
#: model never sees a free-form mood that could smuggle in an instruction.
MOODS = ("continue", "revisit", "late_night", "warm_food", "keep_the_promise")
MOOD_DEFAULT = "continue"

_SYSTEM = """You are the wayfinder of a synthetic Hong Kong arc written in three arms.
You receive the real chapter index (numbers + titles only) and the reader's state. Return JSON ONLY:
{"chapter": <int>, "reason": "<one sentence>", "notice": "<one sentence>", "confidence": "low|medium|high"}
Hard rules: `chapter` MUST be one of the chapter numbers listed in CANDIDATES — never invent a
number. `reason` and `notice` must be grounded in the supplied titles; do not invent a merchant,
place, person or beat; no URLs, no markdown. If the candidates do not support an honest answer,
return {} rather than a plausible invention.
"""


class _WayState(TypedDict, total=False):
    locale: str
    position: int
    mood: str
    chapter_no: int
    candidates: list[dict[str, Any]]
    corpus: str
    choice: dict[str, Any]
    clean: dict[str, Any]
    degraded: bool
    reason: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _read_lines(path: Path) -> dict[int, str]:
    """Parse ``NNN · time · place — beat`` into a number→title map. File is the frozen source."""
    out: dict[int, str] = {}
    try:
        text = io.open(path, encoding="utf-8").read()
    except OSError:
        return out
    for line in text.splitlines():
        m = re.match(r"\s*(\d{1,3})\s*·\s*(.+?)\s*$", line)
        if not m:
            continue
        n = int(m.group(1))
        if 1 <= n <= ARC_SIZE:
            out[n] = m.group(2).strip()
    return out


def _digest_text() -> str:
    try:
        return io.open(DIGEST, encoding="utf-8").read()
    except OSError:
        return ""


def _locate_node(state: _WayState) -> _WayState:
    raw = state.get("position") or 0
    try:
        pos = int(raw)
    except (TypeError, ValueError):
        pos = 0
    pos = max(0, min(ARC_SIZE, pos))
    raw_mood = state.get("mood")
    mood = raw_mood if isinstance(raw_mood, str) and raw_mood in MOODS else MOOD_DEFAULT
    return {"chapter_no": pos, "mood": mood}


def _shortlist_node(state: _WayState) -> _WayState:
    arc = _read_lines(INDEX)
    if not arc:
        return {"degraded": True, "reason": "atlas_unreadable"}
    pos = state["chapter_no"]
    mood = state["mood"]

    if mood == "revisit":
        # earlier beats the reader may have skipped: a spread across the arc, never past their position
        anchor = pos or ARC_SIZE
        picks = [n for n in (anchor - 40, anchor - 24, anchor - 8, 1) if 1 <= n <= ARC_SIZE and n != pos]
    elif pos == 0:
        picks = [1, 2, 3, 21]  # an honest cold start: the first rooms of the day
    else:
        picks = [n for n in (pos + 1, pos + 2, pos + 3) if 1 <= n <= ARC_SIZE]
        if mood == "late_night":
            picks = [n for n in picks if "夜" in arc.get(n, "") or "晚" in arc.get(n, "")] or picks
        if mood == "warm_food":
            picks = [n for n in picks if any(k in arc.get(n, "") for k in ("麵", "粥", "茶", "食", "酒"))] or picks
        if mood == "keep_the_promise":
            picks = [n for n in picks if any(k in arc.get(n, "") for k in ("約", "等", "信", "答", "門"))] or picks

    # de-duplicate, keep order, and only ever hand the model real atlas entries
    seen: set[int] = set()
    candidates: list[dict[str, Any]] = []
    for n in picks:
        if n in seen or n not in arc:
            continue
        seen.add(n)
        candidates.append({"chapter": n, "title": arc[n]})
    if not candidates:
        return {"degraded": True, "reason": "empty_shortlist"}
    return {
        "candidates": candidates,
        "corpus": "\n".join(f"{c['chapter']} · {c['title']}" for c in candidates),
    }


async def _choose_node(state: _WayState) -> _WayState:
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"degraded": True, "reason": "no_model"}
    digest = _digest_text()
    prompt = (
        f"Reader state: position={state['chapter_no']} (0 means a new reader), mood={state['mood']}, "
        f"locale={state['locale']}.\n\n"
        f"WHOLE ARC (grounding, do not choose from here directly):\n{digest}\n\n"
        f"CANDIDATES (choose `chapter` from these numbers ONLY):\n{state.get('corpus', '')}\n\n"
        f"Write `reason` and `notice` in {'Chinese' if state['locale'] != 'en' else 'English'}. JSON only."
    )
    try:
        reply = await llm_call(_SYSTEM, prompt, 220)
    except Exception:
        return {"degraded": True, "reason": "model_unavailable"}
    if not isinstance(reply, dict):
        return {"degraded": True, "reason": "non_json_reply"}
    return {"choice": reply}


def _verify_node(state: _WayState) -> _WayState:
    choice = state.get("choice") or {}
    allowed = {c["chapter"] for c in state.get("candidates", [])}
    n = choice.get("chapter")
    if not isinstance(n, int) or isinstance(n, bool) or n not in allowed:
        return {"degraded": True, "reason": "chapter_outside_shortlist", "clean": {}}

    def field(name: str, cap: int) -> str:
        value = choice.get(name)
        if not isinstance(value, str) or not value.strip() or len(value) > cap or _URL_RE.search(value):
            return ""
        if state["locale"] != "en" and not _CJK_RE.search(value):
            return ""  # CJK locale must not receive an English-leftover sentence
        if state["locale"] == "en" and _CJK_RE.search(value):
            return ""  # the reverse: no Chinese glyphs in the English arm
        return value.strip()

    reason, notice = field("reason", 240), field("notice", 240)
    confidence = choice.get("confidence")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if not reason and not notice:
        return {"degraded": True, "reason": "all_fields_refused", "clean": {}}

    return {
        "degraded": False,
        "clean": {
            "chapter": n,
            "title": next(c["title"] for c in state["candidates"] if c["chapter"] == n),
            "reason": reason,
            "notice": notice,
            "confidence": confidence.lower(),
            "mood": state["mood"],
        },
    }


def build_graph():
    graph = StateGraph(_WayState)
    graph.add_node("locate", _locate_node)
    graph.add_node("shortlist", _shortlist_node)
    graph.add_node("choose", _choose_node)
    graph.add_node("verify", _verify_node)
    graph.set_entry_point("locate")
    graph.add_edge("locate", "shortlist")
    graph.add_conditional_edges("shortlist", lambda s: END if s.get("degraded") else "choose")
    graph.add_conditional_edges("choose", lambda s: END if s.get("degraded") else "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_wayfinder(*, locale: str, position: int, mood: str,
                        llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None) -> dict[str, Any]:
    """Never raises. A refused recommendation is an honest empty result with a reason."""
    try:
        final = await compiled_graph().ainvoke({
            "locale": locale, "position": position, "mood": mood, "llm_call": llm_call,
        })
    except Exception as exc:
        return {"degraded": True, "reason": f"graph_error:{type(exc).__name__}", "clean": {}}
    if final.get("degraded"):
        return {"degraded": True, "reason": final.get("reason", "refused"), "clean": {}}
    return {"degraded": False, **final["clean"]}
