"""D1490 — the 50K–90K input-context capability is a hard, testable budget, not a docstring."""

from __future__ import annotations

import asyncio

from nexus_ai.orchestrator import arc_audit_graph as g


def test_the_context_budget_is_real_code_in_the_expected_range():
    assert g.TARGET_PROMPT_TOKENS_MIN == 50_000
    assert g.TARGET_PROMPT_TOKENS_MAX == 90_000
    assert g.MAX_CORPUS_CHARS == 270_000
    assert g.TARGET_PROMPT_TOKENS_MIN < g.TARGET_PROMPT_TOKENS_MAX


def test_the_measured_l_to_p_window_fits_inside_the_budget():
    """42 chapters / 174,489 chars ≈ 58,957 prompt tokens — the real live measurement."""
    measured_chars = 174_489
    assert measured_chars < g.MAX_CORPUS_CHARS
    approx_tokens = measured_chars // g.CHARS_PER_TOKEN_APPROX
    assert g.TARGET_PROMPT_TOKENS_MIN <= approx_tokens <= g.TARGET_PROMPT_TOKENS_MAX


def test_an_oversized_corpus_is_refused_before_any_model_call(monkeypatch):
    called = {"n": 0}

    async def llm(*a, **k):
        called["n"] += 1
        return {}

    # Force the ceiling below any real window so the guard fires deterministically.
    monkeypatch.setattr(g, "MAX_CORPUS_CHARS", 1)
    out = asyncio.run(g.run_arc_audit(start=145, end=154, llm_call=llm))
    assert called["n"] == 0
    assert out["degraded"] is True
    assert out["reason"] == "corpus_over_budget"


def test_an_ordinary_window_still_passes_the_budget():
    called = {"n": 0}

    async def llm(*a, **k):
        called["n"] += 1
        return {"inconsistencies": [], "thematic_line": "x",
                "head_reader_question": "y", "confidence": "low"}

    out = asyncio.run(g.run_arc_audit(start=149, end=154, llm_call=llm))
    assert called["n"] == 1
    assert out["degraded"] is False
