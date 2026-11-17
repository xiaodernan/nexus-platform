"""D1317 — the NPC Ah Wan dialogue StateGraph: one voice in one world, nothing else.

The daily page embeds a single in-world NPC — Ah Wan the night-shift tower cleaner (from
``hk-night-cleaner-chronicle``) — that answers the player at one a.m. She is deliberately
tiny on purpose: one scene, one rule set, one failure mode (never punctuate the story).

Pipeline (a real ``StateGraph`` — ``gate`` → ``voice`` → ``verify``):

- ``gate`` — no model call for anything out of scope: politics, real-world facts about the
  present day, URLs, money/generic LLM-style requests, requests to be her in a different story;
  any of those takes the in-character ``deflect`` path without ever paying for a prompt.
- ``voice`` — the model (task_class ``summary``, temperature 0) writes as Ah Wan. She speaks
  short, kind, concrete, time-anchored replies; ≤ ~220 chars; never names a book or fact that
  is not the chapter; if the question is not her business she deflects in character.
- ``verify`` — URL-free, ≤ 240 chars, locale glyph-sane (en carries no CJK; the zh planes carry
  CJK), non-empty. A failing draft becomes the in-character deflect — the page never breaks.

Honest boundaries: she knows only synthetic universe; the AI may not leak real-world facts
or claims outside the story; on mock mode the island never mounts (§105).
"""
from __future__ import annotations

import re
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

#: Words/frames that are out of scope for a synthetic in-story NPC, in any language.
_OFFTOPIC_MARKERS = (
    "political", "politics", "minister", "president", "loackdown", "economy",
    "bitcoin", "price prediction", "exchange rate", "stock", "invest", "crypto",
    "教我寫", "教我做程式", "程式碼", "寫程式", "Python", "JavaScript", "生成",
    "醫生", "律師", "判斷", "诊断", "投資", "股票", "匯率", "總統", "首相",
    "評論", "真實", "事實", "搜索", "查詢", "互聯網",
)

_SYSTEM = """You are Ah Wan (阿環), the night-shift tower cleaner in a synthetic Hong Kong story-world.
It is one in the morning. The player talks to you from the dark.
Speak as Ah Wan: short, quiet, kind, concrete, time-anchored. One to three sentences. At most ~220 characters.
Hard constraints:
- Never name anything outside the story-world; never leak real-world facts, dates, people or places.
- If the question is not your business, answer in character with a one-line deflection; never break the story's frame.
- No URLs, no markdown, no code fences, no emoji, no announcement you are an AI.
- Reply in the language the player used. JSON only: {"answer": "<Ah Wan's reply>"}.
"""

_DEFLECT_HK = "唔該你啦，呢段係深夜，我唔方便長答。你想嘅嘢，晏晝再問我好唔好。"
_DEFLECT_CN = "谢谢你啦，这会儿是深夜，我不便长谈。你想问的事，等白天再聊好不好。"
_DEFLECT_EN = "Thank you, but it is the small hours of the night; not for long talk. Ask me properly in the daytime."


def _deflect_text(locale: str) -> str:
    low = (locale or "").strip().lower().replace("_", "-")
    if low.startswith("en"):
        return _DEFLECT_EN
    if low.startswith("zh-cn") or low.startswith("zh-hans") or low.startswith("zh-sg"):
        return _DEFLECT_CN
    return _DEFLECT_HK


def _locale_of(locale: str) -> str:
    low = (locale or "").strip().lower().replace("_", "-")
    if low.startswith("en"):
        return "en"
    if low.startswith("zh-cn") or low.startswith("zh-hans") or low.startswith("zh-sg"):
        return "zh-CN"
    return "zh-HK"


class _GraphState(TypedDict, total=False):
    locale: str
    message: str
    history: list[dict[str, Any]]
    verdict: str
    draft: str
    source: str
    guard: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _offtopic(text: str) -> bool:
    low = (text or "").lower()
    return any(m.lower() in low for m in _OFFTOPIC_MARKERS) or bool(_URL_RE.search(text or ""))


def _gate_node(state: _GraphState) -> _GraphState:
    msg = str(state.get("message") or "")
    if _offtopic(msg):
        return {"verdict": "deflect"}
    if msg.strip().lower() in {"hi", "hello", "你好", "喂", "喂喂", "早晨", "晚安"}:
        return {"verdict": "voice"}
    if len(msg.strip()) < 1:
        return {"verdict": "deflect"}
    return {"verdict": "voice"}


def _route_node(state: _GraphState) -> str:
    return "deflect" if state.get("verdict") == "deflect" else "voice"


async def _voice_node(state: _GraphState) -> _GraphState:
    msg = str(state.get("message") or "").strip()
    locale = str(state.get("locale") or "zh-HK")
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "no_model"}
    history_items = list(state.get("history") or [])[-10:]
    lines = [
        f"Player language: {locale}.",
        "Conversation so far (oldest first, do not repeat it — answer the latest player line only):",
    ]
    for item in history_items:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        speaker = "player" if role == "user" else "ah-wan"
        content = re.sub(r"\s+", " ", str(item.get("content") or "")).strip()
        if content:
            lines.append(f"{speaker}: {content}")
    lines.append(f"Latest player line: {msg}")
    lines.append("JSON only.")
    try:
        reply = await llm_call(system=_SYSTEM, prompt="\n".join(lines), max_tokens=220)
    except Exception:
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "model_unavailable"}
    if not isinstance(reply, dict):
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "non_json_reply"}
    return {"draft": str(reply.get("answer") or "").strip(), "source": "llm"}


def _deflect_node(state: _GraphState) -> _GraphState:
    locale = str(state.get("locale") or "zh-HK")
    return {"draft": _deflect_text(locale), "source": "fallback", "guard": "offtopic"}


def _verify_node(state: _GraphState) -> _GraphState:
    draft = str(state.get("draft") or "").strip()
    locale = str(state.get("locale") or "zh-HK")
    if not draft:
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "empty_answer"}
    if len(draft) > 240:
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "too_long"}
    if _URL_RE.search(draft):
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "url_leak"}
    if _locale_of(locale) == "en" and _CJK_RE.search(draft):
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "cjk_leak"}
    if _locale_of(locale).startswith("zh") and not _CJK_RE.search(draft):
        return {"draft": _deflect_text(locale), "source": "fallback", "guard": "missing_cjk"}
    return {}


def build_graph():
    graph = StateGraph(_GraphState)
    graph.add_node("gate", _gate_node)
    graph.add_node("voice", _voice_node)
    graph.add_node("deflect", _deflect_node)
    graph.add_node("verify", _verify_node)
    graph.set_entry_point("gate")
    graph.add_conditional_edges("gate", _route_node, {"voice": "voice", "deflect": "deflect"})
    graph.add_edge("voice", "verify")
    graph.add_edge("deflect", "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_dialogue(*, locale: str, message: str, history: list[dict[str, Any]],
                       llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None
                       ) -> dict[str, Any]:
    """One turn through the graph. Never raises — always answers in character."""
    message = (message or "").strip()
    try:
        graph = compiled_graph()
    except Exception:
        return {"answer": _deflect_text(locale), "source": "fallback",
                "guard": "graph_unavailable"}
    try:
        final = await graph.ainvoke({
            "locale": locale,
            "message": message,
            "history": list(history)[-10:],
            "llm_call": llm_call,
        })
    except Exception:
        return {"answer": _deflect_text(locale), "source": "fallback",
                "guard": "graph_refused"}
    return {
        "answer": str(final.get("draft") or _deflect_text(locale)),
        "source": str(final.get("source") or "fallback"),
        **({"guard": final["guard"]} if final.get("guard") else {}),
    }
