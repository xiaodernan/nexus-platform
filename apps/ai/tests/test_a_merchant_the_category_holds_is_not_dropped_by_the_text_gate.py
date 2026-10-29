"""D615 - a merchant the requested category holds is dropped because its NAME omits the user's word.

`_filter_static` scored the query TEXT first and `continue`d on `hits == 0 and not name_hit` BEFORE
its category block ran - two separate reads of one row, with the veto first, so a row the text gate
struck never reached the bucket gate. This unit's own patch is what joined them. So on the lane that
serves users when the plane is degraded - `api/demo_data.py::demo_backend()`, the labelled catalogue
behind every
degraded response - the answer to a category request depends on whether the merchant's own strings
spell the word the user used. Measured (`tmp/d615_gate_split.txt`):

  附近有餐廳嗎  restaurant  category gate keeps 4, shipped keeps 2   (the two whose names say 餐廳)
  想飲杯咖啡    cafe        category gate keeps 1, shipped keeps 0
  想去買嘢      retail      category gate keeps 1, shipped keeps 0

The live lane does not do this: its text is a SELECTed score and a `text_matched` flag, never a WHERE
clause (sql.py:314-329). Measured (`tmp/d615_same_request.txt`): 想飲啤酒 returns 39 bars with
text_matched on NONE of them, 想去買嘢 returns 20 retail merchants with text_matched on none - the
plane answers a request no merchant mentions, because the request named the category. D488/D549/D607
filed this shape three times (one request, two lanes, two answers); this is the fourth instance and
the one a user on the degraded path sees as "no results".

The fix is order, not threshold: a row that answers the bucket the request named is a match, so the
text gate does not veto it. `text_matched` and `kw_score` keep their current meanings - a
category-only row arrives with the text score it earned (0), so it ranks below a row the user's words
actually appear in, and the request that names no category is untouched.

One spelling note: the assertions say 想飲咖啡, not the 想飲杯咖啡 the dump above quotes. 杯 is a
character no `nexus_ai` DATA string carries, and `test_vocabulary_is_the_reference.py` reads a test
file's constants (a docstring is prose, so this paragraph is not what it scans). Both sentences
resolve to `category='cafe'` for the same reason - the cue is 咖啡 - so the shorter one asserts
exactly what the longer one was asserting - `tmp/d615_door_reword2.txt` prints the two
side by side: same `bucket='cafe'`, same `hits=0`, same `name_hit=False`, and the same
`pre-D615 bytes would have kept it=False`.
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


def plan_of(text: str) -> S.SearchPlan:
    """The plan the shipped pipeline builds from the user's own words."""
    state = {"intent": "discover_merchant", "language": "zh-HK", "raw_query": text}
    return S.plan_from_intent(merge_turn(state, text).as_intent_model())


def served(text: str) -> list[str]:
    cards, _r, _b, _s = asyncio.run(S.search(backend=demo_backend(), plan=plan_of(text)))
    return [c.title for c in cards]


def kept_rows(text: str, rows: list[dict], filters: dict) -> list[dict]:
    return S._filter_static(copy.deepcopy(rows), text, filters)


def kept(text: str, rows: list[dict], filters: dict) -> list[str]:
    return [r["slug"] for r in kept_rows(text, rows, filters)]


def cafe_row(**kw) -> dict:
    row = {"id": "m1", "slug": "tea", "display_name": "Bamboo Tea House",
           "display_name_zh": "竹苑茶室", "name": "bamboo", "name_zh": "竹苑茶室",
           "description": "茶座", "category_primary": "cafe", "district": "Central",
           "tags": ["tea"], "avg_price_hkd": 60, "attributes": {}}
    row.update(kw)
    return row


def catalogue(name: str) -> dict:
    """A row of the SHIPPED demo catalogue, looked up by its ASCII name."""
    row = next(m for m in demo_backend().merchants if m["display_name"] == name)
    return {**row, "slug": row["slug"]}


def card_title(name: str) -> str:
    """How the shipped card prints this catalogue row: the Chinese name, then the ASCII one."""
    zh = (catalogue(name).get("display_name_zh") or "").strip()
    return f"{zh} {name}".strip()


class TestTheTextGateDoesNotVetoTheCategory:
    def test_a_bucket_match_survives_words_that_appear_nowhere_in_the_row(self):
        # The exact shape the demo catalogue serves: an English-named cafe, a Chinese request.
        rows = [cafe_row()]
        assert kept("", rows, {"category": "cafe"}) == ["tea"]
        assert kept("想飲咖啡", rows, {"category": "cafe"}) == ["tea"]

    def test_the_shipped_catalogue_row_itself_survives_its_own_bucket(self):
        row = catalogue("Bamboo Tea House")
        assert kept("想飲咖啡", [dict(row)], {"category": "cafe"}) == [row["slug"]]

    def test_a_text_match_in_the_wrong_bucket_is_still_not_an_answer(self):
        # The category leg keeps filtering: the word is in the row and the bucket is not.
        rows = [cafe_row(slug="shop", category_primary="retail",
                         display_name="Coffee Shop", display_name_zh="咖啡")]
        assert kept("想飲咖啡", rows, {"category": "cafe"}) == []

    def test_a_request_that_names_no_category_is_left_to_the_text_gate(self):
        # The fix is about the bucket leg only: with no bucket named, a word the row never
        # spells is still no answer (and the demo catalogue genuinely holds no salon).
        rows = [cafe_row(), cafe_row(id="m2", slug="shop", category_primary="retail",
                                     display_name="Rainbow Sports Store")]
        assert kept("Rainbow", rows, {}) == ["shop"]
        assert kept("想飲咖啡", rows, {}) == []

    def test_a_bucket_match_the_words_never_hit_earns_no_text_score(self):
        # Keeping the row is not the same as ranking it first: the words still score the words.
        rows = [cafe_row(slug="says-it", display_name_zh="咖啡茶室"),
                cafe_row(id="m2", slug="does-not", display_name_zh="竹苑茶室")]
        out = kept_rows("想飲咖啡", rows, {"category": "cafe"})
        assert [r["slug"] for r in out] == ["says-it", "does-not"], out
        assert out[0]["kw_score"] > out[1]["kw_score"] == 0.0, out


class TestTheDemoPathServesItsOwnCatalogue:
    def test_the_cafe_request_gets_the_cafe_the_catalogue_holds(self):
        assert served("想飲咖啡") == [card_title("Bamboo Tea House")]

    def test_the_shopping_request_gets_the_shop_the_catalogue_holds(self):
        assert served("想去買嘢") == [card_title("Rainbow Sports Store")]

    def test_the_restaurant_request_gets_every_restaurant_the_catalogue_holds(self):
        titles = served("附近有餐廳嗎")
        assert len(titles) == 4, titles
        for name in ("Silver Mine Restaurant", "Lan Kwai Fong Bistro",
                     "Spice Market Kitchen", "Harbour View Dining"):
            assert any(name in x for x in titles), (name, titles)


@live
def test_the_users_words_never_narrow_what_the_live_filter_keeps():
    """The mirror claim the fixture lane has to hold: on the plane, text scores and never vetoes."""
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="")

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            out = {}
            for text in ("想飲咖啡", "想去買嘢", "附近有餐廳嗎"):
                plan = plan_of(text)
                bucket = plan.filters.get("category")
                common = dict(tenant_id=S.DEFAULT_TENANT_ID, geo=None, radius_m=None,
                              limit=100000, filters={"category": bucket}, embedding=None)
                browsed = await backend.merchant_candidates(text=None, **common)
                asked = await backend.merchant_candidates(text=plan.query_text, **common)
                out[bucket] = ({r["slug"] for r in browsed}, {r["slug"] for r in asked})
            return out
        finally:
            await db_pool.dispose()

    sets = asyncio.run(_go())
    for bucket, (browsed, asked) in sets.items():
        assert browsed == asked, (
            f"category={bucket}: the plane kept {len(browsed)} merchants for the bucket alone and "
            f"{len(asked)} once the user's words were added - live-only "
            f"{sorted(browsed - asked)[:3]}, words-only {sorted(asked - browsed)[:3]}")
