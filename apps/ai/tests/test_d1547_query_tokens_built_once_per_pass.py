"""D1547 - the static filter lane builds the QUERY TOKENS once per pass, not once per row.

`_filter_static` fixes `low = (text or "").lower()` ABOVE its `for r in rows` loop, then called the
pure `_static_tokens(low)` INSIDE the loop: N rows re-tokenised the same string (whitespace tokens
plus CJK bigrams - `search/tokens.py::cjk_bigrams`). This is the same class as D1546, one line
further along the lane, and the same claim: request-invariant work belongs outside the row loop.

The door is a TRANSPARENT spy on the module-level function - it records the argument, calls through
and returns the real value, so no verdict leg can be propped up by the spy itself. R1 and R3 count
the calls; R2 compares the kept rows, their `kw_score` and their `text_matched` against the same
request run unspied, which is the leg the wrong-value mutation arm reddens; R4 shows an empty
request text never tokenises at all.
"""
from __future__ import annotations

from nexus_ai.search import service as S


def _spy(monkeypatch):
    """Wrap `_static_tokens` without changing what it returns."""
    seen: list[str] = []
    real = S._static_tokens

    def spy(low: str):
        seen.append(low)
        return real(low)

    monkeypatch.setattr(S, "_static_tokens", spy)
    return seen


def _rows(n: int) -> list[dict]:
    return [
        {
            "subject_id": f"s{i}",
            "id": f"s{i}",
            "display_name": "安靜咖啡" if i % 2 == 0 else f"Cafe {i}",
            "name": f"Cafe {i}",
            "description": "海景位" if i % 3 == 0 else "市街",
        }
        for i in range(n)
    ]


def _verdict(rows: list[dict]) -> list[tuple]:
    """What a caller can actually observe: which rows survive, and what the text lane said of them."""
    return [(r["subject_id"], r["kw_score"], r["text_matched"]) for r in rows]


class TestQueryTokensBuiltOncePerPass:
    def test_r1_tokens_built_once_for_eight_rows(self, monkeypatch):
        seen = _spy(monkeypatch)
        kept = S._filter_static(_rows(8), "安靜", {})
        # D658: text is a SCORE here, never a WHERE - every row survives and what the text lane
        # says about each one is the observable.
        assert {r["subject_id"] for r in kept} == {f"s{i}" for i in range(8)}
        assert {r["subject_id"] for r in kept if r["text_matched"]} == {"s0", "s2", "s4", "s6"}
        assert seen == ["安靜"]           # once, with the request's own lowered text

    def test_r2_verdict_matches_the_unspied_call(self, monkeypatch):
        baseline = _verdict(S._filter_static(_rows(8), "安靜 海景", {}))
        seen = _spy(monkeypatch)
        spied = _verdict(S._filter_static(_rows(8), "安靜 海景", {}))
        assert spied == baseline
        assert len(seen) == 1

    def test_r3_count_does_not_scale_with_rows(self, monkeypatch):
        seen = _spy(monkeypatch)
        S._filter_static(_rows(200), "安靜", {})
        assert len(seen) == 1

    def test_r4_no_text_never_tokenises(self, monkeypatch):
        seen = _spy(monkeypatch)
        kept = S._filter_static(_rows(8), "", {})
        assert len(kept) == 8
        assert seen == []
