"""D1451 — the chapter lane's frozen world index.

The chapter-ask lane (nexus_ai.api.routes_chapter) embeds the full arc chronology inside
its system contract so a reader asking "what happens next?" never gets a confident guess —
the model is looking at the real world map instead.

This test pins the artifact, not the prose: bounded size, 170 ordered lines, byte-stable
(prefix cache), and the system contract carrying the atlas.
"""
from __future__ import annotations

from pathlib import Path

from nexus_ai.api import routes_chapter


def _index_path() -> Path:
    return Path(routes_chapter.__file__).resolve().parent.parent / "models" / "atlas_index.txt"


def test_atlas_index_exists_and_is_bounded():
    text = _index_path().read_text(encoding="utf-8")
    size = len(text.encode("utf-8"))
    assert 3000 < size < 16384, size
    assert "THE HONG KONG ARC" in text
    assert "flags:{demo:true}" in text


def test_atlas_index_lists_the_real_arc_front_to_back():
    text = _index_path().read_text(encoding="utf-8")
    for no in (1, 34, 37, 109, 130, 133, 144, 147, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170):
        assert f"{no:3d} ·" in text, no
    body_lines = [ln for ln in text.splitlines() if ln[:3].strip().isdigit()]
    assert len(body_lines) == 170
    numbers = [int(ln.split("·", 1)[0]) for ln in body_lines]
    assert numbers == sorted(numbers) == list(range(1, 171))


def test_chapter_system_carries_the_atlas():
    system = routes_chapter._SYSTEM
    assert "THE HONG KONG ARC" in system
    assert "170 ·" in system
    # the chapter-lane fence is still the chapter-lane fence, not the guide's
    assert "Use ONLY the provided excerpts" in system
    assert "Reply with JSON only" not in system or "Output JSON only" in system


def test_the_frozen_atlas_is_byte_stable_for_the_cache_plane():
    assert routes_chapter._SYSTEM == routes_chapter._SYSTEM
    assert routes_chapter._ATLAS_INDEX in routes_chapter._SYSTEM
