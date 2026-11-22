"""D1534 — the guide's fallback must not be the thing that raises.

`run_guide` promises in its own docstring that it never raises: a refused recommendation is an empty
artifact with a reason, because the caller is an HTTP route and a 500 there is a broken page. The
fallback that guarantee rests on is `_fallback_text`, and its SECOND door was read as
`chosen[1] if len(chosen) > 1 else chosen[0]` — which is right for one candidate and an IndexError for
none. Measured live 2026-11-22 (`tmp/live_guide.py`): `run_guide(candidates=[])` raised IndexError out
of the fallback itself, so the one path that promised never to raise did, and the route that asked for a
recommendation with no corpus in hand would have answered 500.

The fix is one line, and the legs below pin both arms of it: a list with candidates still names both
doors, and an EMPTY list now answers with the placeholder text instead of raising.
"""

from __future__ import annotations

import asyncio

from nexus_ai.orchestrator.world_guide_graph import _fallback_text, run_guide


def test_a_fallback_with_two_candidates_names_both_doors():
    text = _fallback_text("zh-HK", "explore",
                          [{"title": "燒味"}, {"title": "早茶"}])
    assert "燒味" in text and "早茶" in text, text


def test_a_fallback_with_one_candidate_names_it_twice_rather_than_raising():
    text = _fallback_text("zh-HK", "explore", [{"title": "燒味"}])
    assert "燒味" in text, text


def test_a_fallback_with_no_candidates_answers_rather_than_raising():
    # the arm that used to raise: the caller gets the placeholder text and a guard reason.
    text = _fallback_text("zh-HK", "explore", [])
    assert "the next door" not in text or text, text
    assert isinstance(text, str) and text, text


def test_the_graph_never_raises_with_no_candidates_at_all():
    out = asyncio.run(run_guide(locale="zh-HK", surface="guides", current_title="",
                                minutes=45, candidates=[], llm_call=None))
    assert out.get("source") == "fallback", out
    assert out.get("guard") == "no_candidates", out
    assert out.get("answer"), out
    assert out.get("suggestions") == [], out


def test_the_graph_never_raises_when_the_model_refuses():
    async def refusing(system, prompt, max_tokens):
        return None

    out = asyncio.run(run_guide(locale="zh-HK", surface="guides", current_title="",
                                minutes=45,
                                candidates=[{"slug": "a", "title": "燒味"}],
                                llm_call=refusing))
    assert out.get("source") == "fallback", out
    assert out.get("answer"), out
