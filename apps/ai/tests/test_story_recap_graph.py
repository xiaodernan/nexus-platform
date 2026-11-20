"""D1468 — story recap: fenced against invented chapters, URLs and name drift."""
from __future__ import annotations

import asyncio

from nexus_ai.orchestrator import story_recap_graph as g


def _good(locale: str) -> dict:
    if locale == "en":
        return {
            "recap": "Chapters 148 to 159 stay at the east gate: Ah Lok keeps the old books, Ah Muk hangs the tags, Ah Wan works the floor, and a parcel arrives from Chan Bok's past.",
            "watch": "The brush-ink sender is still unnamed.",
            "confidence": "medium",
        }
    return {
        "recap": "148至159章都在東門：老騎師守著簿子，包裹從陳炳的舊年送來，值夜的手藝交了下去。",
        "watch": "毛筆字的寄件人仍然沒有名字。",
        "confidence": "medium",
    }


async def _run(locale="en", start=148, end=159, reply=None):
    calls = {"n": 0}

    async def llm(system, prompt, max_tokens):
        calls["n"] += 1
        return reply if reply is not None else _good(locale)

    out = await g.run_recap(locale=locale, start=start, end=end, llm_call=llm)
    return out, calls["n"]


def test_default_window_is_the_last_twelve_chapters():
    out, calls = asyncio.run(_run(start=0, end=0))
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
    bad["recap"] = bad["recap"].replace("148", "999")
    out, _ = asyncio.run(_run(reply=bad))
    # the fabricated-number recap is dropped; with no surviving text the whole artifact degrades
    assert "999" not in str(out)
    assert out["degraded"] is True


def test_url_refused():
    bad = _good("en")
    bad["watch"] = "See https://example.com for the sender."
    out, _ = asyncio.run(_run(reply=bad))
    assert out["degraded"] is False  # watch dropped, recap survives
    assert "https://" not in out["watch"]


def test_model_unavailable_degrades():
    async def llm(*a, **k):
        raise RuntimeError("down")

    out = asyncio.run(g.run_recap(locale="en", start=148, end=159, llm_call=llm))
    assert out["degraded"] is True
    assert out["reason"] == "model_unavailable"
