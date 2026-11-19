"""D1464 — the three-arm drafting bench: a StateGraph that drafts an EN arm from a zh-HK chapter.

The HK arc ships in three arms (zh-HK canonical, opencc-folded Simplified, full English).
Until now the English arm was hand-written chapter by chapter — correct, but it does not use the
model where the model is actually useful: carrying an existing scene across a language boundary
without inventing a merchant, a place or a beat. This graph is the drafting bench for that job.

Pipeline (a real ``StateGraph`` — ``source`` → ``draft`` → ``guard`` → END):

- ``source``: reads the chapter by slug from ``seed.ts`` with a deterministic parser; no network,
  no fallback to a different chapter — an unknown slug refuses.
- ``draft``: ONE model call at temperature 0. The model receives the canonical title, description
  and block list and returns a JSON arm with the SAME block sequence (paragraph/heading/cards)
  and the same card titles. It may phrase; it may not add a fact, a place, a price or a URL.
- ``guard``: deterministic fence on the draft — block count and types match the source, every
  string is URL-free, every English paragraph/heading carries no CJK glyph, the synthetic
  narrative marker survives, recurring character names keep their canonical English spelling
  (a live run turned 陳炳 into "Chan Ping" and 阿穆 into "Ah Mu" while passing every other fence),
  and nothing over-runs the field caps. A failed guard returns ``degraded: true`` with a reason
  and an EMPTY arm — the draft never silently enters the repo.

This bench NEVER writes to ``seed.ts`` and is never on a request path. It hands a reviewed patch
to the operator; the opencc Simplified fold still regenerates from the canonical zh-HK arm.

Run by hand (costs one call):

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_MID=gpt-6.2-sol NEXUS_LLM_PROXY=http://127.0.0.1:7897 \
    uv run python draft_en_arm_bench.py --slug hk-some-chapter-chronicle
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, TypedDict

from langgraph.graph import END, StateGraph

SEED = Path(__file__).resolve().parent.parent / "web" / "src" / "lib" / "mock" / "seed.ts"

_URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

#: The arc's recurring people. A drafter may paraphrase a beat, never re-name a person —
#: the same discipline the io identity lock applies to the operator's own facts.
NAME_MAP = {
    "陳炳": "Chan Bok",
    "阿樂": "Ah Lok",
    "阿穆": "Ah Muk",
    "阿穩": "Ah Wan",
    "阿游": "Ah Yau",
    "阿顏": "Ah Yan",
    "阿權": "Ah Kuen",
}
_MAX_TITLE = 200
_MAX_DESCRIPTION = 400
_MAX_TEXT = 2400

_DRAFT_SYSTEM = """You are the English-arm drafter for the NEXUS Hong Kong arc, a synthetic narrative world.
You will receive ONE chapter in Traditional Chinese (a canonical title, a description and its ordered body blocks).
Write the full English arm for the SAME chapter. Output JSON ONLY with this exact shape:
{"title_en": "<string>", "description_en": "<string>", "body_blocks_en": [ ... ]}
Rules:
- body_blocks_en MUST have exactly the same length, order and block types as the source body_blocks. For a `cards` block, keep its `title` translated and its `items` array empty.
- Keep the synthetic-narrative framing: every opening paragraph must say this is a synthetic narrative (not travel advice) and that the people and places are fictional.
- Phrase the same beats in English. NEVER add a merchant, a street, a date, a price, a character, a rule or a plot beat that is not in the source. Never invent a real-world claim.
- No URLs, no markdown, no code fences. Each paragraph/heading under 2400 characters.
- The translation must read as warm, quiet prose, never as a literal word-for-word gloss.
"""


class _BenchState(TypedDict, total=False):
    slug: str
    source: dict[str, Any]
    arm: dict[str, Any]
    degraded: bool
    reason: str
    llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None


def load_chapter(slug: str) -> dict[str, Any] | None:
    text = io.open(SEED, encoding="utf-8").read()
    start = text.find(f"slug: '{slug}'")
    if start < 0:
        return None
    nxt = text.find("\n    slug: '", start + 10)
    block = text[start : nxt if nxt > 0 else len(text)]

    def field(name: str) -> str:
        m = re.search(rf"\b{name}:\s*'((?:[^'\\]|\\.)*)'", block)
        return m.group(1) if m else ""

    blocks_raw = re.search(r"body_blocks:\s*\[([\s\S]*?)\n    \]", block)
    blocks: list[dict[str, Any]] = []
    if blocks_raw:
        for m in re.finditer(r"\{\s*type:\s*'(\w+)'[^}]*?text:\s*'((?:[^'\\]|\\.)*)'", blocks_raw.group(1)):
            blocks.append({"type": m.group(1), "text": m.group(2)})
        # cards blocks carry a title, not text — capture them too
        for m in re.finditer(r"\{\s*type:\s*'cards',\s*title:\s*'((?:[^'\\]|\\.)*)'", blocks_raw.group(1)):
            blocks.append({"type": "cards", "title": m.group(1)})
        # restore source order by position of `type:` tokens
        order = [m.group(1) for m in re.finditer(r"type:\s*'(\w+)'", blocks_raw.group(1))]
        blocks.sort(key=lambda b: order.index(b["type"]) if b["type"] in order else 999)
    if not blocks:
        return None
    return {"title": field("title"), "description": field("description"), "body_blocks": blocks}


def _source_node(state: _BenchState) -> _BenchState:
    chapter = load_chapter(state["slug"])
    if chapter is None:
        return {"degraded": True, "reason": "chapter_not_found"}
    return {"source": chapter}


async def _draft_node(state: _BenchState) -> _BenchState:
    source = state.get("source")
    if not source:
        return {"degraded": True, "reason": "no_source"}
    llm_call = state.get("llm_call")
    if llm_call is None:
        return {"degraded": True, "reason": "no_model"}
    prompt = (
        f"Canonical title: {source['title']}\n"
        f"Canonical description: {source['description']}\n\n"
        f"Ordered body blocks (JSON):\n{json.dumps(source['body_blocks'], ensure_ascii=False)}\n\n"
        "JSON only."
    )
    try:
        reply = await llm_call(_DRAFT_SYSTEM, prompt, 1400)
    except Exception:
        return {"degraded": True, "reason": "model_unavailable"}
    if not isinstance(reply, dict):
        return {"degraded": True, "reason": "non_json_reply"}
    return {"arm": reply}


def _guard_node(state: _BenchState) -> _BenchState:
    arm = state.get("arm") or {}
    source = state.get("source") or {}

    def refuse(reason: str) -> _BenchState:
        return {"degraded": True, "reason": reason, "arm": {}}

    title = arm.get("title_en")
    description = arm.get("description_en")
    blocks = arm.get("body_blocks_en")
    src_blocks = source.get("body_blocks") or []
    if not (isinstance(title, str) and title.strip()):
        return refuse("empty_title")
    if not (isinstance(description, str) and description.strip()):
        return refuse("empty_description")
    if not isinstance(blocks, list) or len(blocks) != len(src_blocks):
        return refuse("block_count_mismatch")
    for got, want in zip(blocks, src_blocks):
        if not isinstance(got, dict) or got.get("type") != want.get("type"):
            return refuse("block_type_mismatch")
    strings = [title, description]
    for b in blocks:
        strings.extend(v for v in b.values() if isinstance(v, str))
    for s in strings:
        if _URL_RE.search(s):
            return refuse("url_leak")
    prose = [b for b in blocks if b.get("type") in {"paragraph", "heading"}]
    if not prose:
        return refuse("no_prose")
    for b in prose:
        if _CJK_RE.search(str(b.get("text") or "")):
            return refuse("cjk_leak")
    if len(title) > _MAX_TITLE or len(description) > _MAX_DESCRIPTION:
        return refuse("field_too_long")
    if any(len(str(b.get("text") or "")) > _MAX_TEXT for b in prose):
        return refuse("field_too_long")
    first = str(prose[0].get("text") or "")
    if "synthetic" not in first.lower():
        return refuse("missing_synthetic_marker")
    # A name is a fact, not a stylistic choice. Live proof: the first real draft turned
    # 陳炳 into "Chan Ping" and 阿穆 into "Ah Mu" while passing every structural fence.
    source_text = json.dumps(source, ensure_ascii=False)
    arm_text = " ".join(strings)
    for zh, en in NAME_MAP.items():
        if zh in source_text and en.lower() not in arm_text.lower():
            return refuse(f"name_drift:{en}")
    return {"degraded": False, "arm": {"title_en": title.strip(), "description_en": description.strip(), "body_blocks_en": blocks}}


def build_graph():
    graph = StateGraph(_BenchState)
    graph.add_node("read", _source_node)
    graph.add_node("phrase", _draft_node)
    graph.add_node("verify", _guard_node)
    graph.set_entry_point("read")
    graph.add_conditional_edges("read", lambda s: END if s.get("degraded") else "phrase")
    graph.add_conditional_edges("phrase", lambda s: END if s.get("degraded") else "verify")
    graph.add_edge("verify", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def draft_arm(*, slug: str, llm_call: Callable[..., Awaitable[dict[str, Any] | None]] | None) -> dict[str, Any]:
    """Never raises — a refused draft is an honest empty patch with a reason."""
    try:
        return await compiled_graph().ainvoke({"slug": slug, "llm_call": llm_call})
    except Exception as exc:
        return {"degraded": True, "reason": f"graph_error:{type(exc).__name__}", "arm": {}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    args = ap.parse_args()
    if not (os.environ.get("NEXUS_LLM_BASE_URL") and os.environ.get("NEXUS_LLM_API_KEY")):
        print(__doc__)
        sys.exit(3)

    from nexus_ai.config import get_settings
    from nexus_ai.models.factory import get_pool
    from nexus_ai.models.base import LLMRequest

    settings = get_settings()
    pool = get_pool(settings)
    adapter = pool.get("openai") or pool.get("anthropic")
    if adapter is None:
        print("no live adapter from env", file=sys.stderr)
        sys.exit(4)

    async def llm_call(system: str, prompt: str, max_tokens: int):
        from nexus_ai.models.prefix_contract import contract_for

        req = LLMRequest(
            task_class="summary",
            payload={"slug": args.slug},
            system=contract_for("chapter_arm_draft", system),
            prompt=prompt,
            max_tokens=int(max_tokens),
            temperature=0.0,
            json_hint="json_object",
        )
        call = await adapter.complete(req)
        try:
            parsed = json.loads(call.text) if call.text else None
        except Exception:
            parsed = None
        return parsed if isinstance(parsed, dict) else None

    result = asyncio.run(draft_arm(slug=args.slug, llm_call=llm_call))
    public = {k: result.get(k) for k in ("degraded", "reason", "arm")}
    out = json.dumps(public, ensure_ascii=False, indent=2)
    from tempfile import gettempdir

    Path(gettempdir(), f"draft-{args.slug}.json").write_text(out, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
