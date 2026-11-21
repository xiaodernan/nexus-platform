"""Deterministic lexical retrieval over the full HK chapter corpus (§四 RAG).

Unlike the merchant-document RAG, this reads the actual chapter bodies from `seed.ts` —
every paragraph, not the one-line atlas index. A reader's question is scored against each
chapter with a CJK-bigram + Latin-word overlap, and the top chunks are returned with their
chapter number and slug. No embeddings, no network, no nondeterminism: the same question
always retrieves the same chunks, which is what makes the model call cacheable.

The graph that consumes these chunks owns the facts; the model only phrases the answer.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

SEED = Path(__file__).resolve().parents[3] / "web" / "src" / "lib" / "mock" / "seed.ts"

_CHAPTER_RE = re.compile(r"slug: '([^']+)', title: '([^']+)'")
_PARA_RE = re.compile(r"\{ type: 'paragraph', text: '([^']*(?:\\'[^']*)*)' \}")

#: How much of the corpus one answer may see. Bounded so a cross-chapter question stays
#: affordable and the frozen prefix can carry most of the prompt.
MAX_CHUNKS = 8
CHUNK_CHARS = 520


def _chapters() -> list[dict[str, Any]]:
    """Parse the seed into {slug, title, body} records — the same source the web serves."""
    text = io.open(SEED, encoding="utf-8").read()
    starts = [(m.start(), m.group(1), m.group(2)) for m in _CHAPTER_RE.finditer(text)]
    out: list[dict[str, Any]] = []
    for i, (pos, slug, title) in enumerate(starts):
        if not slug.startswith("hk-"):
            continue
        end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
        block = text[pos:end]
        # only the zh-HK body blocks (before body_blocks_en)
        zh = block.split("body_blocks_en:")[0]
        paras = [m.group(1) for m in _PARA_RE.finditer(zh)]
        # Every chapter opens with the same synthetic-guide disclaimer. Strip it so chunk
        # selection grounds on the actual scene, not on boilerplate shared by all 170.
        paras = [re.sub(r"合成敘事指南[^：]{0,24}：", "", x) for x in paras]
        out.append({"slug": slug, "title": title, "body": "\n".join(paras)[:4000]})
    return out


def _terms(query: str) -> set[str]:
    """CJK bigrams + Latin words — enough lexical signal without an embedding model."""
    q = query.lower()
    out = set(re.findall(r"[a-z0-9]{2,}", q))
    cjk = re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", q)
    out.update("".join(cjk[i:i + 2]) for i in range(len(cjk) - 1))
    out.update(cjk)
    return {t for t in out if t}


def _score(chapter: dict[str, Any], terms: set[str]) -> int:
    hay = (chapter["title"] + "\n" + chapter["body"]).lower()
    return sum(hay.count(t) for t in terms)


def retrieve(query: str, *, limit: int = MAX_CHUNKS,
             chunk_chars: int = CHUNK_CHARS) -> list[dict[str, Any]]:
    """Top-`limit` chapters by lexical overlap, each with the most relevant chunk.

    D1514: `chunk_chars` widens the per-chapter excerpt for the reader's explicit "deep
    read" mode. Both knobs are bounded by the caller's whitelist (never by raw client
    bytes), so a deep question can put ~30k characters of REAL chapter body in front of
    the model while the default lane keeps its original 8×520 cost. Retrieval stays
    deterministic for a given (query, limit, chunk_chars) triple — the byte-stable excerpt
    is what makes the frozen head's prefix cache meaningful.
    """
    terms = _terms(query)
    if not terms:
        return []
    chunk_chars = max(160, min(chunk_chars, 4000))
    limit = max(1, min(limit, 40))
    ranked = []
    for chapter in _chapters():
        s = _score(chapter, terms)
        if s > 0:
            ranked.append((s, chapter))
    ranked.sort(key=lambda pair: (-pair[0], pair[1]["slug"]))
    out = []
    for score, chapter in ranked[:limit]:
        body = chapter["body"]
        # choose the window with the densest term hits
        best, best_hits = "", -1
        for i in range(0, max(1, len(body) - chunk_chars + 1), max(1, chunk_chars // 2)):
            window = body[i:i + chunk_chars]
            hits = sum(window.lower().count(t) for t in terms)
            if hits > best_hits:
                best, best_hits = window, hits
        out.append({
            "slug": chapter["slug"],
            "title": chapter["title"],
            "excerpt": best or body[:chunk_chars],
            "score": score,
        })
    return out
