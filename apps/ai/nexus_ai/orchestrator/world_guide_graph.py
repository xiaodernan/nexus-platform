"""D1306 — the world-guide StateGraph: where to next, one honest step forward.

The reader is standing somewhere inside the Hong Kong arc (or on the guides index) with a
finite amount of time, and asks the practical question every traveller asks: *where now?*
This graph answers it — it does not decide what is "best", it decides what is *next*, and
speaks like a calm tour-guide who has walked the route a thousand times.

Pipeline (a real ``StateGraph`` — ``classify`` → ``select`` → ``phrase`` → ``verify``):

- ``classify`` — intent from where the ask happened and how much time is in hand:
  ``home`` → ``settle`` (the arc's front door is the right first step),
  an ask from inside a chapter → ``deepen`` (continue the thread the reader is on),
  twenty minutes or less → ``snack`` (bite-size chapters), else → ``explore``.
- ``select`` — deterministic scoring of the web lane's curated candidates (never the model's
  inventions). ``snack`` prefers short blurbs, ``deepen`` prefers lexical continuity with the
  chapter in view, ``explore``/``settle`` keep the curated order; the first two survive.
- ``phrase`` — the model (injected as ``llm_call``) writes ONE recommendation in the reader's
  language, grounded strictly in the two curated candidates. On ANY failure the draft is the
  deterministic fallback template — the reader is never blocked by the model's silence.
- ``verify`` — the draft must be non-empty, ≤ 420 chars, URL-free, and language-sane
  (``en`` must carry no CJK glyph, the Chinese locales must carry CJK). A failed draft is
  discarded for the fallback template, byte-identical to the one ``phrase`` would have used.

Honest boundaries: the model picks between two *real* chapters the web lane curated; it may
reorder them via ``pick`` (1 or 2) and phrase *why*, but it cannot name a third place, and the
suggestion list the caller renders comes from the deterministic selection, not from the reply.
"""
from __future__ import annotations

import re
from typing import Any, Awaitable, Callable, TypedDict

import logging

from langgraph.graph import END, StateGraph

log = logging.getLogger("nexus_ai.orchestrator.world_guide_graph")

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_WORD_RE = re.compile(r"[a-z0-9_]{2,}")
_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_STOPWORDS = {
    "at", "the", "of", "on", "and", "to", "in", "a", "an", "or", "its", "his", "her",
    "we", "you", "your", "my", "is", "are", "was", "be", "as", "by", "for", "with",
}

from pathlib import Path

_ATLAS_PATH = Path(__file__).resolve().parent.parent / "models" / "atlas_digest.txt"


def _load_atlas() -> str:
    """Frozen Hong Kong arc digest — real corpus titles, deterministic bytes.

    Fail-open to the bare contract: if the artifact is absent the lane runs exactly
    as it did before the atlas existed (degraded never blocks the reader).
    """
    try:
        text = _ATLAS_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        log.warning("world guide: atlas digest unreadable at %s — falling back to the bare contract", _ATLAS_PATH)
        return ""
    return text


def _atlas_block() -> str:
    body = _load_atlas()
    if not body:
        return ""
    return (
        "\n\nTHE HONG KONG ARC — real corpus background (never quoted, never cited beyond the doors):\n"
        + body
        + "\nREMEMBER: the atlas grounds your phrasing in the world that exists. It is NOT a menu.\n"
        "You may NOT name any place, character, dish, staircase, or chapter number from the atlas.\n"
        "You may only choose between the two doors given above.\n"
    )


_BASE_SYSTEM = """You are the NEXUS world guide — a calm, unhurried tour-guide voice inside an infinite story-world.
You will be told where the reader is standing, how much time they have, and exactly two curated candidates (never your choice to invent more).
Recommend ONE as the very next step and say one warm, concrete sentence about why, in the reader's language.
Hard constraints:
- Use ONLY the two candidates. Never invent a place, character, event or price that is not in them.
- Refer to the candidates as "1" and "2" when you name them; the caller renders the doors.
- No URLs, no markdown, no code fences, no bold, no tables; at most ~320 characters.
- Reply with JSON only: {"answer": "<one to three sentences in the reader's language>", "pick": 1|2}.
"""

#: The model's voice — unhurried, in-world, one recommendation at a time, grounded in the real corpus.
SYSTEM = _BASE_SYSTEM + _atlas_block()

_FALLBACK_EN = (
    "A gentle compass — {intent}: start with “{t1}”; if the light holds, “{t2}” will still be "
    "open when you are ready. Take the door that called your name."
)
_FALLBACK_HK = (
    "旅途嘅指南針——{intent}：先去「{t1}」，睇完之後個天仲未黑嘅話，「{t2}」都喺度等緊你。"
    "撳邊扇門你個心應，就行邊扇。"
)
_FALLBACK_CN = (
    "旅途的指南针——{intent}：先去「{t1}」，看完之后天还没黑的话，「{t2}」还在那里等你。"
    "摸哪扇门心里有数，就从哪扇进去。"
)

_INTENT_LABEL = {
    "en": {"settle": "settle in", "snack": "a short taste", "deepen": "deeper down", "explore": "wander"},
    "zh-HK": {"settle": "安頓落嚟", "snack": "小酌一口", "deepen": "順住呢條線行深一啲", "explore": "遊蕩"},
    "zh-CN": {"settle": "安顿下来", "snack": "小酌一口", "deepen": "顺着这条线再深一点", "explore": "游荡"},
}


def _locale_of(locale: str) -> str:
    loc = (locale or "").strip().lower().replace("_", "-")
    if loc.startswith("en"):
        return "en"
    if loc.startswith("zh-cn") or loc.startswith("zh-sg") or loc.startswith("zh-hans"):
        return "zh-CN"
    return "zh-HK"


def _intent_label(locale: str, intent: str) -> str:
    table = _INTENT_LABEL.get(_locale_of(locale)) or _INTENT_LABEL["en"]
    return table.get(intent) or table["explore"]


def _bigram_tokens(text: str) -> set[str]:
    """Order-sensitive-pair overlap: English word bigrams (stopwords removed) and CJK character
    bigrams, with a whole-run anchor for long CJK phrases. A shared word is not continuity —
    a shared STEP is. This is what stops 'yum cha' from beating the actual cha caan teng chapter."""
    lower = (text or "").lower()
    tokens: set[str] = set()
    words = [w for w in _WORD_RE.findall(lower) if w not in _STOPWORDS]
    if len(words) == 1:
        tokens.add(f"u:{words[0]}")
    for a, b in zip(words, words[1:]):
        tokens.add(f"w:{a} {b}")
    for run in _CJK_RUN_RE.findall(lower):
        if len(run) == 1:
            tokens.add(f"c:{run}")
            continue
        for i in range(len(run) - 1):
            tokens.add(f"c:{run[i:i + 2]}")
        if len(run) >= 3:
            tokens.add(f"r:{run}")
    return tokens


def _fallback_text(locale: str, intent: str, chosen: list[dict[str, Any]]) -> str:
    t1 = str((chosen[0] if chosen else {}).get("title") or "the next door")
    t2 = str((chosen[1] if len(chosen) > 1 else chosen[0]).get("title") or "the one after")
    loc = _locale_of(locale)
    template = {"en": _FALLBACK_EN, "zh-HK": _FALLBACK_HK, "zh-CN": _FALLBACK_CN}[loc]
    return template.format(intent=_intent_label(locale, intent), t1=t1, t2=t2)


class _GraphState(TypedDict, total=False):
    locale: str
    surface: str
    current_title: str
    minutes: int
    candidates: list[dict[str, Any]]
    intent: str
    chosen: list[dict[str, Any]]
    draft: str
    source: str
    guard: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None
    pick: int | None
    thinking: dict[str, Any]


def _classify_node(state: _GraphState) -> _GraphState:
    minutes = int(state.get("minutes") or 30)
    surface = str(state.get("surface") or "guides").strip().lower()
    current = str(state.get("current_title") or "").strip()
    if surface == "home":
        intent = "settle"
    elif current:
        intent = "deepen"
    elif minutes <= 20:
        intent = "snack"
    else:
        intent = "explore"
    return {"intent": intent}


def _select_node(state: _GraphState) -> _GraphState:
    cands = [dict(c) for c in (state.get("candidates") or [])][:6]
    intent = str(state.get("intent") or "explore")
    current = str(state.get("current_title") or "")
    cur_toks = _bigram_tokens(current)

    scored: list[tuple[float, int, dict[str, Any]]] = []
    for index, cand in enumerate(cands):
        if intent == "snack":
            blurb = str(cand.get("blurb") or "")
            score = max(0.0, (240 - len(blurb)) / 240.0)
        elif intent == "deepen":
            cand_toks = _bigram_tokens(str(cand.get("title") or "") + " " + str(cand.get("blurb") or ""))
            score = len(cur_toks & cand_toks) * 3.0 + (6 - index) * 0.01
        elif intent == "settle":
            score = (6 - index) * 0.5
        else:  # explore — the curated order IS the arc order; respect it
            score = (6 - index) * 0.1
        scored.append((score, index, cand))

    if intent in {"snack", "deepen"}:
        scored.sort(key=lambda row: (-row[0], row[1]))
    else:
        scored.sort(key=lambda row: row[1])
    chosen = [cand for _, _, cand in scored[:2]] or cands[:2]
    return {"chosen": chosen,
            "thinking": {"scores": [(round(s, 3), i) for s, i, _ in scored]}}


async def _phrase_node(state: _GraphState) -> _GraphState:
    chosen = [dict(c) for c in (state.get("chosen") or [])]
    intent = str(state.get("intent") or "explore")
    locale = str(state.get("locale") or "zh-HK")
    if not chosen:
        return {"draft": _fallback_text(locale, intent, []), "source": "fallback", "guard": "no_candidates"}

    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"draft": _fallback_text(locale, intent, chosen), "source": "fallback", "guard": "no_model"}

    lines = [
        f"Where the reader stands: {state.get('surface') or 'guides'}"
        + (f", having just finished “{state['current_title']}”" if state.get("current_title") else ""),
        f"Time in hand: {int(state.get('minutes') or 30)} minutes.",
        "Two curated candidates:",
    ]
    for i, cand in enumerate(chosen, 1):
        blurb = str(cand.get("blurb") or "").strip()
        lines.append(f"{i}. {cand.get('title')}" + (f" — {blurb}" if blurb else ""))
    lines.append("JSON only.")

    try:
        reply = await llm_call(system=SYSTEM, prompt="\n".join(lines), max_tokens=320)
    except Exception:
        return {"draft": _fallback_text(locale, intent, chosen), "source": "fallback",
                "guard": "model_unavailable"}

    if not isinstance(reply, dict):
        return {"draft": _fallback_text(locale, intent, chosen), "source": "fallback",
                "guard": "non_json_reply"}

    answer = str(reply.get("answer") or "").strip()
    pick = reply.get("pick")
    try:
        pick = int(pick) if pick is not None else None
    except (TypeError, ValueError):
        pick = None
    if pick in (1, 2) and len(chosen) == 2 and pick == 2:
        chosen = [chosen[1], chosen[0]]

    return {"draft": answer, "source": "llm", "chosen": chosen, "pick": pick}


def _verify_node(state: _GraphState) -> _GraphState:
    draft = str(state.get("draft") or "").strip()
    intent = str(state.get("intent") or "explore")
    locale = str(state.get("locale") or "zh-HK")
    chosen = list(state.get("chosen") or [])

    def refuse(reason: str) -> _GraphState:
        return {"draft": _fallback_text(locale, intent, chosen),
                "source": "fallback", "guard": reason}

    if not draft:
        return refuse("empty_answer")
    if len(draft) > 420:
        return refuse("too_long")
    if _URL_RE.search(draft):
        return refuse("url_leak")
    if _locale_of(locale) == "en" and _CJK_RE.search(draft):
        return refuse("cjk_leak")
    if _locale_of(locale).startswith("zh") and not _CJK_RE.search(draft):
        return refuse("missing_cjk")
    return {}


def build_graph():
    graph = StateGraph(_GraphState)
    graph.add_node("classify", _classify_node)
    graph.add_node("select", _select_node)
    graph.add_node("phrase", _phrase_node)
    graph.add_node("verify", _verify_node)
    graph.set_entry_point("classify")
    graph.add_edge("classify", "select")
    graph.add_edge("select", "phrase")
    graph.add_edge("phrase", "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_guide(*, locale: str, surface: str, current_title: str,
                    minutes: int,
                    candidates: list[dict[str, Any]],
                    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None
                    ) -> dict[str, Any]:
    """One turn through the graph. Never raises — the caller always gets a recommendation."""
    graph = compiled_graph()
    fallback = {
        "answer": _fallback_text(locale, "explore", list(candidates)[:2]),
        "suggestions": [{"slug": str(c.get("slug") or ""), "title": str(c.get("title") or "")}
                        for c in list(candidates)[:2]],
        "source": "fallback",
        "intent": "explore",
        "guard": "graph_refused",
    }
    try:
        final = await graph.ainvoke({
            "locale": locale,
            "surface": surface,
            "current_title": current_title,
            "minutes": minutes,
            "candidates": list(candidates),
            "llm_call": llm_call,
        })
    except Exception:
        return fallback
    chosen = list(final.get("chosen") or list(candidates)[:2])
    return {
        "answer": str(final.get("draft") or fallback["answer"]),
        "suggestions": [{"slug": str(c.get("slug") or ""), "title": str(c.get("title") or "")}
                        for c in chosen[:2]],
        "source": str(final.get("source") or "fallback"),
        "intent": str(final.get("intent") or "explore"),
        **({"guard": final["guard"]} if final.get("guard") else {}),
        **({"pick": final["pick"]} if final.get("pick") in (1, 2) else {}),
    }
