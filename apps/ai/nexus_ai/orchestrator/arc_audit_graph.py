"""D1465 — the arc-audit StateGraph: one corpus pass, fenced for honest output.

The 87K-token whole-arc probe (D1458) asked the model for continuity contradictions. Its raw
reply was printed as-is — exactly the gap D1464's live run exposed elsewhere: a plausible audit
can carry chapter numbers that do not exist, URLs, or invented merchants. This graph is the
fenced successor: `assemble` → `audit` → `verify`, one `reason`-tier call at temperature 0.

- `assemble`: reads `seed.ts`, collects the requested window by parsed Chinese chapter number,
  refuses an empty window. No network, no guessing.
- `audit`: ONE model call over the corpus; expects JSON with `inconsistencies` (each carrying
  two chapter numbers), a `thematic_line`, a `head_reader_question` and a confidence label.
- `verify`: every number must lie inside the window, every issue must be URL-free and bounded,
  at most five rows survive; a row that fails is dropped; an all-invalid reply degrades to an
  EMPTY audit with a reason rather than a confident fabrication.

The operator still decides when to spend the ~60-90K prompt tokens. Never on a request path.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

SEED = Path(__file__).resolve().parents[3] / "web" / "src" / "lib" / "mock" / "seed.ts"

#: D1490 — the audited input-context budget, as code rather than prose. The measured L→P
#: window (42 chapters / 174,489 chars) produced 58,957 prompt tokens; the whole-arc range
#: is 50K–90K. These constants make the budget inspectable by tests and CI, and the MAX
#: below is a hard ceiling on what `assemble` may hand the model — an operator probe that
#: grows past it is refused rather than silently spending unbounded tokens.
TARGET_PROMPT_TOKENS_MIN = 50_000
TARGET_PROMPT_TOKENS_MAX = 90_000
CHARS_PER_TOKEN_APPROX = 3  # measured 174,489 chars -> 58,957 prompt tokens (~2.96)
MAX_CORPUS_CHARS = TARGET_PROMPT_TOKENS_MAX * CHARS_PER_TOKEN_APPROX  # 270,000

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_DIGITS = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
_MULS = {'十': 10, '百': 100, '千': 1000}


def cn_int(raw: str) -> int | None:
    total, cur = 0, 0
    for ch in raw:
        if ch == '零':
            continue
        if ch in _DIGITS:
            cur = cur * 10 + _DIGITS[ch]
        elif ch in _MULS:
            total += (cur or 1) * _MULS[ch]
            cur = 0
        else:
            return None
    return total + cur


def chapter_no(title: str) -> int | None:
    m = re.search(r'第([一二三四五六七八九十百零]{1,7})章', title)
    return cn_int(m.group(1)) if m else None


_SYSTEM = """You are the continuity auditor of a synthetic Hong Kong arc written in three arms.
You receive ONE ordered chapter window. Return JSON ONLY:
{"inconsistencies": [{"chapter_a": <int>, "chapter_b": <int>, "issue": "<one sentence>"}] (<=5),
 "thematic_line": "<one sentence>", "head_reader_question": "<one sentence>",
 "confidence": "low|medium|high"}
Hard rules: both chapter numbers MUST come from the supplied window; issues must be specific and
grounded in the supplied text; do not invent a merchant, place, person or beat; no URLs; if you
find nothing, return an empty inconsistencies list rather than a plausible one.
"""


class _AuditState(TypedDict, total=False):
    start: int
    end: int
    chapters: list[dict[str, Any]]
    corpus: str
    audit: dict[str, Any]
    clean: dict[str, Any]
    degraded: bool
    reason: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def _assemble_node(state: _AuditState) -> _AuditState:
    text = io.open(SEED, encoding='utf-8').read()
    found: list[tuple[int, str, int]] = []
    for m in re.finditer(r"slug: '([a-z0-9-]+)', title: '([^']+)'", text):
        n = chapter_no(m.group(2))
        if n is not None and state['start'] <= n <= state['end']:
            found.append((n, m.group(2), m.start()))
    found.sort(key=lambda r: r[0])
    if not found:
        return {"degraded": True, "reason": "empty_window"}
    starts = [f[2] for f in found]
    parts = []
    for i, (n, title, pos) in enumerate(found):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        parts.append(f"=== Chapter {n} :: {title} ===\n{text[pos:end]}")
    corpus = "\n\n".join(parts)
    # Hard input budget: refuse an oversized assembly rather than silently hand the model
    # an unbounded corpus. The ordinary 42-chapter probe (~174K chars) sits well inside it.
    if len(corpus) > MAX_CORPUS_CHARS:
        return {"degraded": True, "reason": "corpus_over_budget"}
    return {
        "chapters": [{"n": n, "title": title} for n, title, _ in found],
        "corpus": corpus,
    }


async def _audit_node(state: _AuditState) -> _AuditState:
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"degraded": True, "reason": "no_model"}
    prompt = (
        f"Window: {state['start']}-{state['end']} of the arc.\n"
        f"Chapters supplied: {[c['n'] for c in state.get('chapters', [])]}\n\n"
        f"CORPUS:\n{state.get('corpus', '')}\n\nJSON only."
    )
    try:
        reply = await llm_call(_SYSTEM, prompt, 1200)
    except Exception:
        return {"degraded": True, "reason": "model_unavailable"}
    if not isinstance(reply, dict):
        return {"degraded": True, "reason": "non_json_reply"}
    return {"audit": reply}


def _verify_node(state: _AuditState) -> _AuditState:
    audit = state.get("audit") or {}
    window = {c["n"] for c in state.get("chapters", [])}
    rows = audit.get("inconsistencies") if isinstance(audit.get("inconsistencies"), list) else []
    clean: list[dict[str, Any]] = []
    for item in rows[:5]:
        if not isinstance(item, dict):
            continue
        a, b, issue = item.get("chapter_a"), item.get("chapter_b"), item.get("issue")
        if not isinstance(a, int) or not isinstance(b, int) or isinstance(a, bool) or isinstance(b, bool):
            continue
        if a not in window or b not in window:
            continue
        if not isinstance(issue, str) or not issue.strip() or len(issue) > 240 or _URL_RE.search(issue):
            continue
        clean.append({"chapter_a": a, "chapter_b": b, "issue": issue.strip()})

    def text_field(name: str, cap: int) -> str:
        value = audit.get(name)
        if not isinstance(value, str) or not value.strip() or len(value) > cap or _URL_RE.search(value):
            return ""
        return value.strip()

    thematic = text_field("thematic_line", 400)
    question = text_field("head_reader_question", 400)
    confidence = audit.get("confidence")
    if not isinstance(confidence, str) or confidence.lower() not in {"low", "medium", "high"}:
        confidence = "low"
    if not clean and not thematic and not question:
        return {"degraded": True, "reason": "all_fields_refused", "clean": {}}
    return {
        "degraded": False,
        "clean": {
            "inconsistencies": clean,
            "thematic_line": thematic,
            "head_reader_question": question,
            "confidence": confidence.lower(),
        },
    }


def build_graph():
    graph = StateGraph(_AuditState)
    graph.add_node("read", _assemble_node)
    graph.add_node("think", _audit_node)
    graph.add_node("check", _verify_node)
    graph.set_entry_point("read")
    graph.add_conditional_edges("read", lambda s: END if s.get("degraded") else "think")
    graph.add_conditional_edges("think", lambda s: END if s.get("degraded") else "check")
    graph.add_edge("check", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_arc_audit(*, start: int, end: int,
                        llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None) -> dict[str, Any]:
    """Never raises. A refused audit is an honest empty result with a reason."""
    try:
        final = await compiled_graph().ainvoke({"start": start, "end": end, "llm_call": llm_call})
    except Exception as exc:
        return {"degraded": True, "reason": f"graph_error:{type(exc).__name__}", "clean": {}}
    if final.get("degraded"):
        return {"degraded": True, "reason": final.get("reason", "refused"), "clean": {}}
    return {"degraded": False, **final["clean"]}
