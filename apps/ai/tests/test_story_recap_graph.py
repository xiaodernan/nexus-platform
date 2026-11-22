"""D1468 — story recap: fenced against invented chapters, URLs and name drift."""
from __future__ import annotations

import asyncio

from nexus_ai.orchestrator import story_recap_graph as g


def _good(locale: str) -> dict:
    if locale == "en":
        return {
            "recap": "Chapters 164 to 175 stay at the east gate: Ah Lok keeps the old books, Ah Muk hangs the tags, Ah Wan works the floor, and a parcel arrives from Chan Bok's past.",
            "watch": "The brush-ink sender is still unnamed.",
            "confidence": "medium",
        }
    return {
        # CJK fixture characters restricted to the product's own vocabulary
        # (test_vocabulary_is_the_reference refuses hand-written code points).
        "recap": "香港的一日一夜 第一百五十章 東門 寫在這裡",
        "watch": "香港的一日 一章",
        "confidence": "medium",
    }


async def _run(locale="en", start=164, end=175, reply=None):
    calls = {"n": 0}

    async def llm(system, prompt, max_tokens):
        calls["n"] += 1
        return reply if reply is not None else _good(locale)

    out = await g.run_recap(locale=locale, start=start, end=end, llm_call=llm)
    return out, calls["n"]


def test_default_window_is_the_last_twelve_chapters():
    # D1539: the shared fixture names "Chapters 164 to 175" — true when it was written, outside
    # the default window now that the corpus has grown to 178 (the default window is the LAST
    # twelve chapters and it MOVES with the corpus). The fence refuses a reply that names chapters
    # outside its window, so a canned reply carrying absolute numbers reddens here forever after
    # the next chapter lands. This leg replies window-agnostically instead: the fence's window
    # discipline is covered by the invented-number leg below, and this leg only proves the default
    # window resolves and answers with one LLM call.
    reply = {"recap": "The east gate keeps its keys, its books and its tags.",
             "watch": "The brush-ink sender is still unnamed.", "confidence": "medium"}
    out, calls = asyncio.run(_run(start=0, end=0, reply=reply))
    assert calls == 1
    assert out["degraded"] is False
    assert out["recap"]


def test_clean_en_reply_passes():
    out, _ = asyncio.run(_run())
    assert out["degraded"] is False
    assert out["confidence"] == "medium"
    assert "Chan Bok" in out["recap"]


def test_zh_reply_must_carry_cjk():
    bad = _good("en")
    out, _ = asyncio.run(_run(locale="zh-HK", reply=bad))
    assert out["degraded"] is True
    assert out["reason"] == "all_fields_refused"


def test_invented_chapter_number_refused():
    bad = _good("en")
    # both endpoints must be invented: leaving 174 valid would let the recap survive
    bad["recap"] = bad["recap"].replace("164", "999").replace("174", "998")
    out, _ = asyncio.run(_run(reply=bad))
    # the fabricated-number recap is dropped field-by-field; a valid watch survives by
    # design, so the honest assertion is "no invented number reaches the reader".
    assert "999" not in str(out) and "998" not in str(out)
    assert out["recap"] == ""


def test_url_refused():
    bad = _good("en")
    bad["watch"] = "See https://example.com for the sender."
    out, _ = asyncio.run(_run(reply=bad))
    assert out["degraded"] is False  # watch dropped, recap survives
    assert "https://" not in out["watch"]


def test_model_unavailable_degrades():
    async def llm(*a, **k):
        raise RuntimeError("down")

    out = asyncio.run(g.run_recap(locale="en", start=164, end=175, llm_call=llm))
    assert out["degraded"] is True
    assert out["reason"] == "model_unavailable"
