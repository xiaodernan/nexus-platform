"""D1465 — fenced arc audit: no fabricated chapter numbers, no URLs, no empty confident audit."""
from __future__ import annotations

import asyncio

import pytest

from nexus_ai.orchestrator import arc_audit_graph as g


def _good() -> dict:
    return {
        "inconsistencies": [
            {"chapter_a": 145, "chapter_b": 147, "issue": "The east gate is both shut and being re-tagged in the same hour."},
        ],
        "thematic_line": "The car park keeps the same books the shops once kept.",
        "head_reader_question": "Who will hold the gate when the ledger is full?",
        "confidence": "medium",
    }


async def _run(reply, start=145, end=154):
    called = {"n": 0}

    async def llm(system, prompt, max_tokens):
        called["n"] += 1
        return reply

    out = await g.run_arc_audit(start=start, end=end, llm_call=llm)
    return out, called["n"]


def test_assemble_reads_the_window_without_a_call():
    called = {"n": 0}

    async def llm(*a, **k):
        called["n"] += 1
        return None

    out = asyncio.run(g.run_arc_audit(start=149, end=154, llm_call=llm))
    assert called["n"] == 1
    # the window assembled and the model was called; a non-JSON reply must degrade, never invent
    assert out["degraded"] is True
    assert out["reason"] == "non_json_reply"


def test_empty_window_refuses_without_a_call():
    out, calls = asyncio.run(_run(_good(), start=900, end=950))
    assert calls == 0
    assert out["degraded"] is True
    assert out["reason"] == "empty_window"


def test_clean_reply_passes():
    out, calls = asyncio.run(_run(_good()))
    assert calls == 1
    assert out["degraded"] is False
    assert out["inconsistencies"][0]["chapter_a"] == 145
    assert out["confidence"] == "medium"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda a: a["inconsistencies"].append({"chapter_a": 999, "chapter_b": 145, "issue": "x"}),
        lambda a: a["inconsistencies"].append({"chapter_a": 145, "chapter_b": 146, "issue": "https://example.com"}),
        lambda a: a.update(thematic_line="https://example.com"),
        lambda a: a.update(confidence="certain"),
    ],
)
def test_bad_rows_are_dropped_but_the_audit_survives(mutate):
    reply = _good()
    mutate(reply)
    out, _ = asyncio.run(_run(reply))
    assert out["degraded"] is False
    assert all(145 <= row["chapter_a"] <= 154 for row in out["inconsistencies"])
    assert all(145 <= row["chapter_b"] <= 154 for row in out["inconsistencies"])
    assert all("https://" not in row["issue"] for row in out["inconsistencies"])
    assert out["confidence"] in {"low", "medium", "high"}


def test_all_invalid_fields_degrade_to_empty():
    out, _ = asyncio.run(_run({"inconsistencies": [{"chapter_a": 0, "chapter_b": 0, "issue": "x"}],
                              "thematic_line": "", "head_reader_question": "", "confidence": "low"}))
    assert out["degraded"] is True
    assert out["reason"] == "all_fields_refused"
