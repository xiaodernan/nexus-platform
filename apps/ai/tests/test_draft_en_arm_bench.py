"""D1464 — the three-arm drafting bench. Deterministic fence tests, no live network."""
from __future__ import annotations

import pytest

import draft_en_arm_bench as bench

SLUG = "hk-happy-valley-racecourt-east-gate-chalkboard-1960-chronicle"


def _good_arm() -> dict:
    src = bench.load_chapter(SLUG)
    assert src is not None
    blocks = []
    for i, b in enumerate(src["body_blocks"]):
        if b["type"] == "cards":
            blocks.append({"type": "cards", "title": f"Happy Valley, no. {i}", "items": []})
        else:
            text = (
                "Synthetic narrative (not travel advice): a quiet noon in the valley. "
                "Ah Lok, Ah Muk and Chan Bok share a bench. " + "Plain English prose. " * 3
            )
            blocks.append({"type": b["type"], "text": text})
    return {
        "title_en": "Noon — a bench in the valley",
        "description_en": "A synthetic guide (not travel advice): prose only.",
        "body_blocks_en": blocks,
    }


def test_source_parser_reads_the_canonical_arm():
    src = bench.load_chapter(SLUG)
    assert src is not None
    assert "1960" in src["title"]
    assert len(src["body_blocks"]) >= 9
    assert src["body_blocks"][0]["type"] == "paragraph"


def test_unknown_slug_refuses_without_a_call():
    import asyncio

    called = {"n": 0}

    async def llm(*a, **k):
        called["n"] += 1
        return None

    out = asyncio.run(bench.draft_arm(slug="no-such-chapter", llm_call=llm))
    assert out["degraded"] is True
    assert out["reason"] == "chapter_not_found"
    assert called["n"] == 0


def test_a_clean_draft_passes_the_fence():
    import asyncio

    good = _good_arm()

    async def llm(system, prompt, max_tokens):
        assert "SAME block" in system or "same length" in system
        return good

    out = asyncio.run(bench.draft_arm(slug=SLUG, llm_call=llm))
    assert out["degraded"] is False
    assert out["arm"]["title_en"] == good["title_en"]
    assert len(out["arm"]["body_blocks_en"]) == len(good["body_blocks_en"])


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda a: a.update(title_en=""), "empty_title"),
        (lambda a: a.update(body_blocks_en=a["body_blocks_en"][:-1]), "block_count_mismatch"),
        (lambda a: a["body_blocks_en"][0].update(text="https://example.com"), "url_leak"),
        (lambda a: a["body_blocks_en"][0].update(text="早上好，跑馬地"), "cjk_leak"),
        (lambda a: a["body_blocks_en"][0].update(text="English without the marker"), "missing_synthetic_marker"),
        (lambda a: a.update(body_blocks_en=[
            {**b, "text": str(b.get("text") or "").replace("Ah Muk", "Ah Mu")} if b.get("type") != "cards" else b
            for b in a["body_blocks_en"]
        ]), "name_drift:Ah Muk"),
    ],
)
def test_bad_drafts_are_refused(mutate, reason):
    import asyncio

    arm = _good_arm()
    mutate(arm)

    async def llm(*a, **k):
        return arm

    out = asyncio.run(bench.draft_arm(slug=SLUG, llm_call=llm))
    assert out["degraded"] is True
    assert out["reason"] == reason
    assert out["arm"] == {}
