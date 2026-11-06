"""D705 - CJK queries match English tags on merchants in the merchant lane.

The merchant lane's `build_offering_query` (sic: `build_merchant_query`) CJK containment
leg checks `m.tags` against CJK keywords via strpos. But `m.tags` carries English tags
like "ramen", "japanese", "sushi" - a CJK keyword like "拉麵" won't match "ramen" in tags.
The merchant lane's Chinese queries couldn't reach English-tagged merchants.

D705 adds tag-based containment for CJK keywords vs English merchant tags in the merchant
lane's `kw_score`, using the same `_CJK_TO_TAG_MAP` as D696's offering-lane fix.

Pure and DB-free.
"""

from __future__ import annotations

import pytest

from nexus_ai.search.sql import _CJK_TO_TAG_MAP, build_merchant_query


class TestMerchantCjkTagContainment:
    """`build_merchant_query` boosts merchants whose tags match CJK keywords."""

    def test_map_is_not_vacuous(self):
        assert _CJK_TO_TAG_MAP, "the map must name at least one CJK cuisine term"

    def test_拉麵_maps_to_japanese_related_tags(self):
        assert "拉麵" in _CJK_TO_TAG_MAP, "拉麵 should name a tag on merchants"
        tags = _CJK_TO_TAG_MAP["拉麵"]
        assert "japanese" in tags or "ramen" in tags or "sushi" in tags, (
            f"拉麵 should map to japanese/ramen/sushi, got {tags}")

    async def test_cjk_query_reaches_english_tagged_merchant(self):
        import nexus_ai.search.sql as S

        # Monkeypatch cjk_keywords to return the bigram so we test isolation.
        original = S.cjk_keywords
        S.cjk_keywords = lambda text, limit=16: ["拉麵"]
        try:
            q = S.build_merchant_query(
                tenant_id="00000000-0000-0000-0000-000000000001",
                text="拉麵",
                embedding=None,
                filters={},
            )
            # The kw_score should include the tag match leg.
            assert "m.tags &&" in q.sql, (
                f"kw_score should reference m.tags for tag containment, got:\n{q.sql}")
        finally:
            S.cjk_keywords = original

    async def test_non_cjk_query_has_no_tag_leg(self):
        import nexus_ai.search.sql as S

        q = S.build_merchant_query(
            tenant_id="00000000-0000-0000-0000-000000000001",
            text="cafe",
            embedding=None,
            filters={},
        )
        assert "m.tags &&" not in q.sql, (
            f"non-CJK query should not add tag leg, got:\n{q.sql}")
