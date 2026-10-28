"""D596 - the category filter answered 0 on the fixture lane for every live-shaped row.

Categories live in the `categories` tree, and `sql.category_clause` resolves the caller's
bucket into taxonomy slugs and walks one level (a leaf or its parent). `_filter_static`
compared that bucket to `category_primary`, which on a live row holds the leaf's DISPLAY NAME
("Tea House", "Hot Pot", ... 66 distinct values, none of them a bucket). Measured at HEAD on
the live plane: `filters={"category": "cafe"}` kept **79** merchants live and **0** through the
fixture predicate; restaurant **184** and 0; bar **39** and 0. A fixture-backed test that asked
whether a category filter filtered anything was answered "no" for every live-shaped row.

The mirror is data, not taxonomy knowledge: both lanes' SELECT now carry `category_slugs`
(the merchant's leaf slugs AND their parents', the same two levels the clause walks), and
`_filter_static` matches the resolved bucket against them. A fixture that stores the coarse
bucket in `category_primary` itself - the shape all 57 of the suite's own fixture rows use -
keeps the old comparison, so nothing that was right moved.

What this does NOT mirror, named rather than hidden: D524's leaf-exact rule. The live clause
asks the taxonomy whether the caller's spelling is a leaf and, if it is, skips the root walk;
the fixture lane has no taxonomy plane, so it always answers the walk. The two agree on a
bucket or a word (`cafe`, `restaurant`, `tea-house`) and can differ when a caller names a leaf
whose root is what its bucket stands for (`specialty-coffee` -> cafe). Filed in PLAN.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

BUCKETS = ("restaurant", "cafe", "bar", "dessert", "tea-house")


def _row(**kw) -> dict:
    row = {"id": "m1", "slug": "m1", "display_name": "Place", "display_name_zh": "",
           "district": "Central", "tags": [], "avg_price_hkd": 100, "attributes": {}}
    row.update(kw)
    return row


class TestTheFixtureLane:
    def test_a_coarse_bucket_still_filters_the_catalogue_rows(self):
        rows = [_row(id="a", slug="a", category_primary="cafe"),
                _row(id="b", slug="b", category_primary="restaurant")]
        kept = {r["slug"] for r in S._filter_static(rows, "", {"category": "cafe"})}
        assert kept == {"a"}, kept

    def test_resolved_slugs_are_matched_when_the_row_carries_them(self):
        rows = [_row(id="a", slug="a", category_primary="Tea House",
                     category_slugs=["tea-house", "cafe"]),
                _row(id="b", slug="b", category_primary="Hot Pot",
                     category_slugs=["hot-pot", "restaurant"])]
        assert {r["slug"] for r in S._filter_static(rows, "", {"category": "cafe"})} == {"a"}
        assert {r["slug"] for r in S._filter_static(rows, "", {"category": "restaurant"})} == {"b"}

    def test_a_row_with_no_slugs_is_not_kept_by_a_bucket_it_does_not_name(self):
        rows = [_row(id="a", slug="a", category_primary="Tea House", category_slugs=[])]
        assert S._filter_static(rows, "", {"category": "cafe"}) == []


live = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="")
    common = dict(tenant_id=S.DEFAULT_TENANT_ID, text=None, geo=None, radius_m=None,
                  limit=100000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            rows = await backend.merchant_candidates(**dict(common, embedding=None))
            kept = {}
            for bucket in BUCKETS:
                kept[bucket] = {r["slug"] for r in await backend.merchant_candidates(
                    **dict(common, embedding=None, filters={"category": bucket}))}
            return rows, kept
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live
def test_the_live_rows_carry_the_slugs_the_clause_walks(plane):
    rows, _kept = plane
    assert rows and any(r.get("category_slugs") for r in rows), (
        "no live row carries `category_slugs` - the SELECT does not read the tree")


@live
@pytest.mark.parametrize("bucket", BUCKETS)
def test_both_lanes_keep_the_same_merchants(plane, bucket):
    rows, kept = plane
    predicted = {r["slug"] for r in rows
                 if not S._filter_static([dict(r)], "", {"category": bucket}) == []}
    assert kept[bucket] == predicted, (
        f"category={bucket}: live kept {len(kept[bucket])} and the fixture predicate "
        f"{len(predicted)}; live-only {sorted(kept[bucket] - predicted)[:3]}, "
        f"predicate-only {sorted(predicted - kept[bucket])[:3]}")


@live
def test_the_bucket_that_matches_nothing_matches_nothing_on_both(plane):
    _rows, kept = plane
    assert kept["dessert"] == set(), kept["dessert"]
