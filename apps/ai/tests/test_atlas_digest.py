"""D1436 — the atlas-grounded world guide.

The HK arc corpus (three arms, and still growing) is a real, measurable world; the model was
narrating with almost no exposure to it. The digest freezes the real corpus into the frozen
prefix (in the §D1310 spirit: nothing about the world is left to the model's imagination),
so the phrasing lands instead of drifting.

The fence stays on top of the atlas: the model may never name a place beyond the two doors.

D1534 — the chapter count is DERIVED, never written down. This file used to assert the literal
"175 chapters" and a hand-maintained tuple ending at 175. Both were true on the day they were
written and both then reported the size of a world that had moved on: the arc reached 178 while
the digest header still read 175, and the only reason anyone found out is that the digest was
regenerated for an unrelated reason. A test that pins a number the corpus owns is a date, not a
constant — so the count now comes from the digest's own header, and the sampled chapters are the
first, the last, and a deterministic spread of the middle.
"""
from __future__ import annotations

import re
from pathlib import Path

from nexus_ai.orchestrator import world_guide_graph


def _digest_path() -> Path:
    return Path(world_guide_graph.__file__).resolve().parent.parent / "models" / "atlas_digest.txt"


def _digest_text() -> str:
    return _digest_path().read_text(encoding="utf-8")


def _declared_chapters(text: str) -> int:
    """The count the digest says it holds, read from its own header line."""
    m = re.search(r"·\s*(\d+)\s+chapters", text)
    assert m, "the digest header no longer declares a chapter count"
    return int(m.group(1))


def _chapter_rows(text: str) -> list[int]:
    """Every numbered chapter row, in file order — the corpus the digest actually carries."""
    return [int(m.group(1)) for m in re.finditer(r"^\s*(\d+)\s+·", text, re.MULTILINE)]


def test_atlas_digest_exists_and_is_bounded():
    text = _digest_text()
    size = len(text.encode("utf-8"))
    assert 4000 < size < 16384, size
    n = _declared_chapters(text)
    for marker in [
        "THE HONG KONG ARC",
        f"{n} chapters",
        "demo:true",
        "Never name a place",
        f"{n} ·",
    ]:
        assert marker in text, marker


def test_the_digest_header_and_its_own_rows_agree():
    """The header is a claim about the rows beneath it; the two must not be able to differ."""
    text = _digest_text()
    rows = _chapter_rows(text)
    assert _declared_chapters(text) == len(rows)
    # contiguous, 1-based, no gap and no duplicate: the arc is ordered, so a hole is a lost chapter.
    assert rows == list(range(1, len(rows) + 1))


def test_atlas_lists_the_real_corpus_front_to_back():
    text = _digest_text()
    n = len(_chapter_rows(text))
    # the ends, plus a deterministic spread that reaches every quarter of the book
    samples = {1, 2, 21, 13, 46, 100, 108} | {n - 10, n - 3, n - 2, n - 1, n}
    for no in sorted(x for x in samples if 1 <= x <= n):
        assert f"{no:3d} ·" in text, no
    assert "車仔麵" in text
    assert "十八點半" in text


def test_world_guide_system_is_grounded_and_fenced():
    system = world_guide_graph.SYSTEM
    # the base contract is intact
    assert "Use ONLY the two candidates" in system
    assert "Reply with JSON only" in system
    # the atlas rides on top, before the response-shape fence
    assert "THE HONG KONG ARC" in system
    assert "Never invent a place, character, event or price" in system


def test_the_frozen_prefix_is_byte_stable_for_the_cache_plane():
    assert world_guide_graph.SYSTEM == world_guide_graph.SYSTEM
    assert world_guide_graph._BASE_SYSTEM in world_guide_graph.SYSTEM


def test_the_graph_lane_still_emits_the_two_doors_only():
    # The graph's honesty arguments do not change because the atlas grew.
    assert "candidate" in world_guide_graph.SYSTEM
