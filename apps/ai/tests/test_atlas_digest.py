"""D1436 — the atlas-grounded world guide.

The HK arc corpus (156 chapters, three arms) is a real, measurable world; the model was
narrating with almost no exposure to it. The digest freezes the real corpus into the frozen
prefix (in the §D1310 spirit: nothing about the world is left to the model's imagination),
so the phrasing lands instead of drifting.

The fence stays on top of the atlas: the model may never name a place beyond the two doors.
"""
from __future__ import annotations

from pathlib import Path

from nexus_ai.orchestrator import world_guide_graph


def _digest_path() -> Path:
    return Path(world_guide_graph.__file__).resolve().parent.parent / "models" / "atlas_digest.txt"


def test_atlas_digest_exists_and_is_bounded():
    text = _digest_path().read_text(encoding="utf-8")
    size = len(text.encode("utf-8"))
    assert 4000 < size < 16384, size
    for marker in [
        "THE HONG KONG ARC",
        "156 chapters",
        "Layer P open",
        "demo:true",
        "Never name a place",
        "156 ·",
    ]:
        assert marker in text, marker


def test_atlas_lists_the_real_corpus_front_to_back():
    text = _digest_path().read_text(encoding="utf-8")
    for no in (1, 2, 21, 13, 46, 100, 108, 130, 138, 144, 147, 156):
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
