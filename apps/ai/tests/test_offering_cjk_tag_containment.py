"""D696 - CJK queries match English tags on offerings through tag-based containment.

Offerings carry no CJK, so a Chinese keyword like "拉麵" cannot reach an offering
whose merchant carries only English tags ("ramen", "japanese", "sushi"). The merchant
lane's `cjk_keywords()` containment leg already reaches tags on the merchant pool; this
unit adds the same tag leg to the offering lane's kw_score via `_CJK_TO_TAG_MAP`,
mapping CJK cuisine surfaces to the English tags the seed writes on merchant rows.

Pure and DB-free.
"""

from __future__ import annotations

import pytest

from nexus_ai.search.sql import _CJK_TO_TAG_MAP, build_offering_query
from nexus_ai.search.tokens import cjk_keywords


class TestCjkToTagMap:
    """The CJK-to-English tag map maps cuisine surfaces to tags."""

    def test_map_is_not_vacuous(self):
        assert _CJK_TO_TAG_MAP, "the map must name at least one CJK cuisine term"

    def test_拉麵_maps_to_japanese_related_tags(self):
        assert "拉麵" in _CJK_TO_TAG_MAP, "拉麵 should name a tag on merchants"
        tags = _CJK_TO_TAG_MAP["拉麵"]
        assert "japanese" in tags or "ramen" in tags or "sushi" in tags, (
            f"拉麵 should map to japanese/ramen/sushi, got {tags}")

    def test_日料_maps_to_tags(self):
        assert "日料" in _CJK_TO_TAG_MAP, "日料 should name a tag on merchants"

    def test_每个字都映射到非空标签列表(self):
        for cjk, tags in _CJK_TO_TAG_MAP.items():
            assert tags, f"{cjk} maps to an empty tag list"


class TestOfferingCjkTagContainment:
    """build_offering_query boosts offerings whose merchants carry tags matched by CJK."""

    async def test_cjk_query_reaches_english_tagged_offering(self):
        # "拉麵" should match an offering whose merchant carries the "ramen" tag,
        # even though the offering's own name/description have no Chinese.
        import nexus_ai.search.sql as S

        # Monkeypatch cjk_keywords to return the bigram so we test isolation.
        original = S.cjk_keywords
        S.cjk_keywords = lambda text, limit=16: ["拉麵"]
        try:
            q = build_offering_query(
                tenant_id="00000000-0000-0000-0000-000000000001",
                text="拉麵",
                filters={},
            )
            # The kw_score should include the tag match leg.
            assert "m.tags &&" in q.sql, (
                f"kw_score should reference m.tags for tag containment, got:\n{q.sql}")
        finally:
            S.cjk_keywords = original

    async def test_non_cjk_query_has_no_tag_leg(self):
        q = build_offering_query(
            tenant_id="00000000-0000-0000-0000-000000000001",
            text="cafe",
            filters={},
        )
        assert "m.tags &&" not in q.sql, (
            f"non-CJK query should not add tag leg, got:\n{q.sql}")

    def test_cjk_keywords_returns_bigrams(self):
        # "拉麵" is 2 CJK chars, so it returns itself as one keyword.
        assert cjk_keywords("拉麵") == ["拉麵"]
        # "我想食拉麵" - the CJK run "我想食拉麵" is longer than 4 chars, so it breaks into bigrams.
        kw = cjk_keywords("我想食拉麵")
        assert "拉麵" in kw, f"拉麵 bigram should be in {kw}"
