"""D1497 — the world-answer lane: real cross-chapter RAG, fenced output, honest refusal."""

from __future__ import annotations

import asyncio

from nexus_ai.orchestrator import world_answer_graph as g
from nexus_ai.retrieval.chapter_rag import _chapters, retrieve


def test_the_full_corpus_is_parsed_from_the_seed():
    chapters = _chapters()
    assert len(chapters) >= 170
    assert all(c["slug"].startswith("hk-") for c in chapters)
    assert all("合成敘事指南" not in c["body"] for c in chapters)  # disclaimer stripped


def test_retrieval_is_deterministic_and_grounded_in_real_bodies():
    a = retrieve("東門 鎖匙 阿晴", limit=3)
    b = retrieve("東門 鎖匙 阿晴", limit=3)
    assert a == b
    assert a
    assert all(x["slug"] and x["excerpt"] for x in a)
    assert a[0]["score"] >= a[-1]["score"]


def test_empty_query_retrieves_nothing():
    assert retrieve("   ") == []


def test_no_relevant_chapters_short_circuits_without_a_call():
    called = {"n": 0}

    async def llm(*a, **k):
        called["n"] += 1
        return {}

    out = asyncio.run(g.run_world_answer("zzzznotawordqqq", "en", llm))
    assert called["n"] == 0
    assert out["degraded"] is True


def test_a_grounded_answer_passes_with_its_citations():
    async def llm(system, prompt, max_tokens):
        return {"answer": "阿晴接過三條鎖匙，為走夜路的人亮燈【第166章】。", "confidence": "high"}

    out = asyncio.run(g.run_world_answer("東門 鎖匙 阿晴", "zh-HK", llm))
    assert out["degraded"] is False
    assert out["confidence"] == "high"
    assert 166 in out["chapters"]


def test_an_invented_chapter_number_is_refused():
    async def llm(system, prompt, max_tokens):
        return {"answer": "這件事發生在【第9999章】。", "confidence": "high"}

    out = asyncio.run(g.run_world_answer("東門 鎖匙", "zh-HK", llm))
    assert out["degraded"] is True
    assert out["reason"] == "chapter_outside_corpus"


def test_a_url_in_the_answer_is_refused():
    async def llm(system, prompt, max_tokens):
        return {"answer": "看 https://example.com 的解釋。", "confidence": "high"}

    out = asyncio.run(g.run_world_answer("東門 鎖匙", "zh-HK", llm))
    assert out["degraded"] is True
    assert out["reason"] == "url_refused"
