"""D616 - the demo catalogue's offerings answer no category, because the bucket leg reads a column
they do not carry.

`_filter_static` decides a row's bucket membership from `category_slugs`, and falls back to
`category_primary` when the row carries no mirror. An offering row carries neither: the demo
catalogue builds it with the parent's bucket under `category`
(`api/demo_data.py:124` - `"category": parent["category_primary"]`), and
`tests/test_demo_data.py::test_category_and_district_inherited` pins that exact key, so the row shape
is an asserted convention and the reader is what is wrong. `_static_avoids`, the refusal leg of this
same predicate, already folds `category_primary or category` for exactly this reason and already picks
a row's lane from the row's own shape - the bucket leg was the one that never learned. Measured
(`tmp/d616_offering_lane.txt`):
the shipped offering lane keeps ZERO of its two rows for every bucket tried - `restaurant`, `cafe`,
`retail`, `bakery`, `ramen`, `bubble-tea`, `shopping`, `footwear` - including `restaurant` for a set
meal whose own row says `restaurant`. The same rows, with the bucket moved to the column the
predicate reads, answer `restaurant` with 1 and `retail` with 1.

The live lane has no such gap: its offering SELECT emits `m.category_primary AS category`
(`sql.py:582`) ALONGSIDE the two-level `category_slugs` mirror (`sql.py:586`, built at 156-161), so
the plane answers these buckets from the mirror - 2384 rows for `restaurant`, 166 for `retail`
(`tmp/d616_offering_live.txt`) - while the degraded path answers both with nothing.

What this unit deliberately does NOT repair: the leaf layer. `bubble-tea` (手搖飲品, a leaf under the
`cafe` root) is not what a demo offering row states - the milk-tea set inherits its parent's
`restaurant` - so a customer asking for a milk tea (`想飲杯奶茶`) is still told the catalogue holds
none, although it holds one by name. Answering that needs taxonomy labels authored onto the fixture
rows, not a predicate change; filed in PLAN with the numbers.
"""

from __future__ import annotations

import asyncio
import copy
import os

import pytest

from nexus_ai.api.demo_data import demo_backend
from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.search import service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

live = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

MILK_TEA = "demo-milk-tea-set"
SHOES = "demo-running-shoes"


def offerings() -> list[dict]:
    return [dict(r) for r in demo_backend().offerings]


def kept(rows: list[dict], bucket: str, text: str = "") -> list[str]:
    out = S._filter_static(copy.deepcopy(rows), text, {"category": bucket},
                           offerings=copy.deepcopy(rows))
    return [str(r["slug"]) for r in out]


def scored(rows: list[dict], bucket: str, text: str) -> dict[str, float]:
    out = S._filter_static(copy.deepcopy(rows), text, {"category": bucket},
                           offerings=copy.deepcopy(rows))
    return {str(r["slug"]): float(r["kw_score"]) for r in out}


def cards_for(bucket: str, subject: tuple[str, ...] = ("offering",)) -> list[str]:
    plan = S.SearchPlan(query_text="", subject_types=subject,
                        filters={"category": bucket}, limit=10)
    cards, _r, _b, _s = asyncio.run(S.search(backend=demo_backend(), plan=plan))
    return [c.title for c in cards]


class TestTheOfferingLane:
    def test_the_bucket_leg_reads_the_column_an_offering_row_states(self):
        rows = offerings()
        assert rows[0]["category"] == "restaurant", "fixture moved - re-read this row"
        assert kept(rows, "restaurant") == [MILK_TEA]
        assert kept(rows, "retail") == [SHOES]

    def test_an_offering_still_answers_no_bucket_it_does_not_state(self):
        rows = offerings()
        for bucket in ("cafe", "bar", "bakery", "ramen"):
            assert kept(rows, bucket) == [], bucket

    def test_words_that_appear_nowhere_in_the_offering_do_not_veto_its_bucket(self):
        # \u60f3\u53bb\u8cb7\u5622 - "want to go shopping": no token of it appears in the
        # sports store's SKU, and the offering lane must not need one.
        sentence = "\u60f3\u53bb\u8cb7\u5622"
        state = {"intent": "purchase", "language": "zh-HK", "raw_query": sentence}
        plan = S.plan_from_intent(merge_turn(state, sentence).as_intent_model())
        assert plan.subject_types == ("offering",), plan.subject_types
        assert plan.filters["category"] == "retail", plan.filters
        rows = S._filter_static(offerings(), plan.query_text, plan.filters,
                                offerings=offerings())
        assert [r["slug"] for r in rows] == [SHOES]

    def test_the_offering_lane_serves_the_card_end_to_end(self):
        titles = cards_for("retail")
        assert len(titles) == 1 and "Trail Running Shoes" in titles[0], titles

    def test_the_bucket_column_an_offering_states_earns_it_no_text_score(self):
        # Reading the column is not the same as scoring it. No live keyword expression scores a
        # category (`sql.py:314-321` scores `m.search_tsv`, the two names, the description and the
        # tags; `sql.py:531-538` does the same for `o.`), so a row kept because it STATES the bucket
        # must still arrive with the text score its words earned - none.
        rows = [{"id": "o3", "slug": "o3", "name": "Set Menu", "category": "restaurant"}]
        assert kept(rows, "restaurant") == ["o3"]
        assert scored(rows, "restaurant", "restaurant") == {"o3": 0.0}


class TestTheOtherShapesAreUntouched:
    def test_a_merchant_written_the_coarse_way_is_still_compared_the_coarse_way(self):
        rows = [{"id": "a", "slug": "a", "display_name": "A", "category_primary": "cafe"},
                {"id": "b", "slug": "b", "display_name": "B", "category_primary": "restaurant"}]
        assert kept(rows, "cafe") == ["a"]
        assert kept(rows, "restaurant") == ["b"]

    def test_the_slug_mirror_still_decides_when_the_row_carries_both(self):
        # an offering that carries the live shape: the coarse `category` is the parent's NAME and
        # the mirror is the slugs. The mirror wins, so the new leg cannot widen a live-shaped row.
        rows = [{"id": "o1", "slug": "o1", "name": "Set", "category": "Bubble Tea",
                 "category_slugs": ["bubble-tea", "cafe"]}]
        assert kept(rows, "cafe") == ["o1"]
        assert kept(rows, "bubble-tea") == ["o1"]
        assert kept(rows, "restaurant") == []

    def test_the_mirror_wins_even_when_the_other_column_names_a_bucket(self):
        # the row above names a DISPLAY NAME, which the equality can never hit. This one names the
        # bucket string itself in `category` while its mirror says `cafe` - the shape a merchant
        # whose `category_primary` is stored as a bucket would give an offering row. The mirror is
        # the more specific statement, so it decides, and the widened leg never gets to vote.
        rows = [{"id": "o4", "slug": "o4", "name": "Set", "category": "restaurant",
                 "category_slugs": ["cafe", "bubble-tea"]}]
        assert kept(rows, "cafe") == ["o4"]
        assert kept(rows, "restaurant") == []

    def test_a_row_carrying_neither_key_is_still_answered_by_no_bucket(self):
        rows = [{"id": "x", "slug": "x", "name": "No category at all"}]
        assert kept(rows, "restaurant") == []

    def test_the_coarse_leg_stays_exact_and_does_not_walk_the_taxonomy(self):
        # the widened leg reads the bucket the ROW states; it does not turn the coarse comparison
        # into the resolved walk, which belongs to the mirror. A fixture row that names a leaf is
        # not an answer to a request that names its root - D596's `== bucket` is still `== bucket`.
        rows = [{"id": "m8", "slug": "m8", "display_name": "Eight",
                 "category_primary": "bakery-dessert"}]
        assert kept(rows, "bakery") == []
        assert kept(rows, "bakery-dessert") == ["m8"]

    def test_the_merchant_lane_of_the_demo_catalogue_is_unchanged(self):
        rows = [dict(r) for r in demo_backend().merchants]
        assert kept(rows, "restaurant") == [
            "demo-silver-mine-restaurant", "demo-lan-kwai-fong",
            "demo-spice-market", "demo-harbour-view-dining"]


@live
def test_the_live_offering_lane_answers_the_bucket_the_demo_now_answers():
    bucket_rows = {}

    async def _go():
        from nexus_ai.config import Settings
        from nexus_ai.db import pool as db_pool

        st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                      internal_token="", db_statement_timeout_ms=60000)
        db = await db_pool.connect(st, force_new=True)
        backend = S.PostgresBackend(db)
        try:
            for bucket in ("restaurant", "retail"):
                rows = await backend.offering_candidates(
                    text=None, filters={"category": bucket}, tenant_id=S.DEFAULT_TENANT_ID,
                    limit=20)
                bucket_rows[bucket] = rows
        finally:
            await db_pool.dispose()

    asyncio.run(_go())
    for bucket, rows in bucket_rows.items():
        assert rows, f"live offering lane answered {bucket} with nothing - the plane moved"
        assert all(r.get("category_slugs") for r in rows), (
            f"{bucket}: a live offering row carries no `category_slugs` mirror")
        assert kept(offerings(), bucket), (
            f"{bucket}: the live plane answers it and the demo catalogue, which states it on its "
            f"own offering row, does not")
