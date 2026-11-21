"""D1497 — the world-answer StateGraph: one question, answered from the FULL corpus.

The other user-facing lanes see the one-line atlas index or a single chapter. This lane
retrieves real chapter bodies across the whole series (chapter_rag), lets the model phrase
ONE short answer, then fences every chapter number and URL. The model never owns a fact.

Pipeline: `retrieve` → `answer` → `verify` (an empty or ungrounded shortlist short-circuits
to END). One temperature-0 call, bounded output, no background spend.
"""

from __future__ import annotations

import re
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

from nexus_ai.retrieval.chapter_rag import retrieve

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_NUM_RE = re.compile(r"第\s*([一二三四五六七八九十百零0-9]{1,6})\s*章|ch(?:apter)?\s*(\d{1,3})", re.IGNORECASE)
_CJK_NUM = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

_SYSTEM = """You are the archivist of a synthetic Hong Kong story world. You receive REAL excerpts from several chapters. Answer the reader's ONE question in their language, in at most 200 characters, using ONLY the supplied excerpts. Cite the chapters you actually used as 【第N章】 inline. Never invent a character, place, event or rule; no URLs, no markdown, no code fences. If the excerpts cannot answer, reply exactly: 「這批章節沒有提供答案。」 (zh) or "These chapters do not answer that." (en). JSON only: {"answer": "...", "confidence": "low|medium|high"}.
"""


#: D1514 — two reader-visible budgets. `quick` is the original D1497 cost; `deep` puts
#: ~27k characters of real chapter body in front of the model for a cross-chapter question.
#: The client names a depth, never a raw token/char count — the graph owns the budget.
DEPTH_BUDGETS: dict[str, dict[str, int]] = {
    "quick": {"limit": 8, "chunk_chars": 520},
    "deep": {"limit": 20, "chunk_chars": 1350},
}
DEPTH_DEFAULT = "quick"


class _State(TypedDict, total=False):
    query: str
    locale: str
    depth: str
    chunks: list[dict[str, Any]]
    allowed: set[int]
    reply: dict[str, Any]
    clean: dict[str, Any]
    degraded: bool
    reason: str
    budget: dict[str, int]
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _cn(raw: str) -> int | None:
    if raw.isdigit():
        return int(raw)
    total, cur = 0, 0
    for ch in raw:
        if ch == "十":
            total += (cur or 1) * 10
            cur = 0
        elif ch == "百":
            total += (cur or 1) * 100
            cur = 0
        elif ch in _CJK_NUM:
            cur = _CJK_NUM[ch]
        else:
            return None
    return total + cur


def _chapter_numbers(text: str) -> set[int]:
    out: set[int] = set()
    for m in _NUM_RE.finditer(text):
        raw = m.group(1) or m.group(2)
        if raw:
            n = _cn(raw)
            if n:
                out.add(n)
    return out


def _retrieve_node(state: _State) -> _State:
    raw_depth = state.get("depth")
    depth = raw_depth if isinstance(raw_depth, str) and raw_depth in DEPTH_BUDGETS else DEPTH_DEFAULT
    budget = DEPTH_BUDGETS[depth]
    chunks = retrieve(state["query"], limit=budget["limit"], chunk_chars=budget["chunk_chars"])
    if not chunks:
        return {"degraded": True, "reason": "no_relevant_chapters"}
    return {
        "chunks": chunks,
        "allowed": set(filter(None, (_infer_no(c) for c in chunks))),
        "budget": {**budget, "body_chars": sum(len(str(c.get("excerpt") or "")) for c in chunks)},
    }


def _infer_no(chunk: dict[str, Any]) -> int:
    """Chapter number from the title's bracket, e.g. （第一百七十章） — never from score."""
    m = re.search(r"第([一二三四五六七八九十百零0-9]{1,6})章", str(chunk.get("title", "")))
    return (_cn(m.group(1)) or 0) if m else 0


async def _answer_node(state: _State) -> _State:
    llm = state.get("llm_call")
    if llm is None:
        return {"degraded": True, "reason": "no_model"}
    corpus = "\n\n".join(
        f"【第{_infer_no(c)}章 · {c['slug']}】\n{c['excerpt']}" for c in state.get("chunks", [])
    )
    prompt = (
        f"Locale: {state['locale']}\nQuestion: {state['query']}\n\n"
        f"EXCERPTS (the only source you may use):\n{corpus}\n\nJSON only."
    )
    try:
        reply = await llm(_SYSTEM, prompt, 260)
    except Exception:
        return {"degraded": True, "reason": "model_unavailable"}
    return {"reply": reply if isinstance(reply, dict) else {}}


def _verify_node(state: _State) -> _State:
    reply = state.get("reply") or {}
    answer = reply.get("answer")
    allowed = state.get("allowed") or set()
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 400:
        return {"degraded": True, "reason": "all_fields_refused", "clean": {}}
    if _URL_RE.search(answer):
        return {"degraded": True, "reason": "url_refused", "clean": {}}
    cited = _chapter_numbers(answer)
    if cited and not cited <= allowed:
        return {"degraded": True, "reason": "chapter_outside_corpus", "clean": {}}
    confidence = reply.get("confidence")
    if confidence not in {"low", "medium", "high"}:
        confidence = "low"
    return {"clean": {"answer": answer, "confidence": confidence, "chapters": sorted(cited)}, "degraded": False}


def build_graph():
    g = StateGraph(_State)
    g.add_node("retrieve", _retrieve_node)
    g.add_node("answer", _answer_node)
    g.add_node("verify", _verify_node)
    g.set_entry_point("retrieve")
    g.add_conditional_edges("retrieve", lambda s: "answer" if not s.get("degraded") else END)
    g.add_edge("answer", "verify")
    g.add_edge("verify", END)
    return g.compile()


_GRAPH = build_graph()


async def run_world_answer(query: str, locale: str = "zh-HK",
                           llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None = None,
                           depth: str = DEPTH_DEFAULT) -> dict[str, Any]:
    # D1514: unknown depths fail closed to `quick` — a client cannot ask for an unbounded
    # budget by inventing a name. The budget that was actually used is reported back.
    if depth not in DEPTH_BUDGETS:
        depth = DEPTH_DEFAULT
    state: _State = {"query": query, "locale": locale, "depth": depth, "llm_call": llm_call}
    try:
        final = await _GRAPH.ainvoke(state)
    except Exception as exc:  # never surface a raw graph crash
        return {"degraded": True, "reason": f"graph_error:{type(exc).__name__}", "answer": "", "confidence": "low"}
    if final.get("degraded"):
        return {"degraded": True, "reason": final.get("reason", "refused"), "answer": "", "confidence": "low"}
    return {"degraded": False, "depth": depth, "budget": final.get("budget", {}), **final.get("clean", {})}
