"""D1451 — the chapter lane's frozen world index.

The chapter-ask lane (nexus_ai.api.routes_chapter) embeds the full arc chronology inside
its system contract so a reader asking "what happens next?" never gets a confident guess —
the model is looking at the real world map instead.

This test pins the artifact, not the prose: bounded size, an ordered 1..N body, byte-stable
(prefix cache), and the system contract carrying the atlas.

D1534 — three pins here were literals (175 lines, `range(1, 176)`, the hardcoded `"175 ·"` in the
contract). When the arc reached 178 all three were wrong at once, and the fence sentence above them
still said "THE 175-CHAPTER HONG KONG ARC" — the number had been copied into four places, so the
corpus could only ever describe itself correctly if someone remembered to edit all four. The count
is now read from the artifact and the contract is asserted to AGREE with it, which is the property
that actually matters: the prompt and the world it describes must not be able to disagree.
"""
from __future__ import annotations

import re
from pathlib import Path

from nexus_ai.api import routes_chapter


def _index_path() -> Path:
    return Path(routes_chapter.__file__).resolve().parent.parent / "models" / "atlas_index.txt"


def _index_text() -> str:
    return _index_path().read_text(encoding="utf-8")


def _chapter_numbers(text: str) -> list[int]:
    return [int(m.group(1)) for m in re.finditer(r"^\s*(\d+)\s+·", text, re.MULTILINE)]


def test_atlas_index_exists_and_is_bounded():
    text = _index_text()
    size = len(text.encode("utf-8"))
    assert 3000 < size < 16384, size
    assert "THE HONG KONG ARC" in text
    assert "flags:{demo:true}" in text


def test_atlas_index_lists_the_real_arc_front_to_back():
    text = _index_text()
    numbers = _chapter_numbers(text)
    n = len(numbers)
    assert n > 100, n
    # ordered and contiguous: a hole means a chapter is missing from the world map while the story
    # still has it, which is the failure this artifact exists to make impossible.
    assert numbers == list(range(1, n + 1))
    for no in sorted({1, 34, 37, 109, 130, 133, n - 10, n - 3, n - 2, n - 1, n}):
        assert f"{no:3d} ·" in text, no


def test_chapter_system_carries_the_atlas():
    system = routes_chapter._SYSTEM
    assert "THE HONG KONG ARC" in system

    # D1534: the contract and the artifact must agree on how many chapters the world has. This is the
    # assertion that would have caught 2026-11-22 — the prompt said 175 while the index carried 178.
    index_n = len(_chapter_numbers(routes_chapter._ATLAS_INDEX))
    assert routes_chapter._ATLAS_CHAPTERS == index_n
    assert f"THE {index_n}-CHAPTER HONG KONG ARC" in system
    assert f"{index_n} ·" in system

    # the chapter-lane fence is still the chapter-lane fence, not the guide's
    assert "Use ONLY the provided excerpts" in system
    assert "Reply with JSON only" not in system or "Output JSON only" in system


def test_the_frozen_atlas_is_byte_stable_for_the_cache_plane():
    assert routes_chapter._SYSTEM == routes_chapter._SYSTEM
    assert routes_chapter._ATLAS_INDEX in routes_chapter._SYSTEM


def test_the_fence_reads_its_number_from_the_index_rather_than_writing_it():
    """The mechanism, not just the current value: a literal here can drift, a derivation cannot."""
    src = Path(routes_chapter.__file__).read_text(encoding="utf-8")
    assert "def _atlas_chapter_count(" in src
    assert not re.search(r"THE\s+\d+-CHAPTER HONG KONG ARC", src), (
        "routes_chapter.py writes the chapter count as a literal again — that number is owned by "
        "the atlas index, and every copy of it is a copy that can fall behind"
    )
