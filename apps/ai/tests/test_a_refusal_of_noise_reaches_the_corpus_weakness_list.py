"""D595 - a refusal of noise or queue reached no row, though the corpus records both facts.

Measured on the live plane at HEAD (2026-10-28): `avoid=["noise"]`, `["queue"]` and
`["smoking"]` each removed **0** of 470 published merchants. The corpus records two of the
three as a LIST attribute - `weak_aspects` names `noise` on 15 merchants and `waiting_time` on
15 - so the refusal wrote a constraint and the hard filter could not see the fact behind it.
The third, `smoking`, has no fact at all: `generate.py` writes no smoking attribute or tag, and
this unit does not invent one (a reader that excluded on a fact the corpus does not write would
be the §5 shape in the other direction).

The join is one vocabulary, read by both lanes: `categories.aspect_terms` maps the lexin's
constraint value to the corpus's aspect name (`noise` -> `noise`, `queue` -> `waiting_time`),
the SQL avoid clause grows one leg on each lane, and `_filter_static` reads the same map so the
fixture backend answers the same question. The offering lane reads the MERCHANT's list, carried
on its row as `merchant_weak_aspects`, because the live clause reads `m.attributes` on both.

Measured after the change, on the same plane: noise 470 -> 455, queue 470 -> 455, smoking
470 -> 470, and the offerings of the noise-weak merchants 4707 -> 4568.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.categories import aspect_terms

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def test_the_refusal_vocabulary_maps_to_the_corpus_aspect_names():
    """The bridge itself: the two spellings that differ, and the one word with no fact."""
    assert aspect_terms("noise") == ["noise"]
    assert aspect_terms("queue") == ["waiting_time"]
    assert aspect_terms("smoking") == [], (
        "smoking is mapped to an aspect the corpus never writes - the generator records no "
        "smoking fact, so any leg here would be excluding on nothing")
    assert aspect_terms("seafood") == []


WEAK_NOISE = {"id": "m-noise", "slug": "noise-weak", "display_name": "Noisy Place",
              "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
              "tags": ["restaurant"], "avg_price_hkd": 120,
              "attributes": {"data_origin": "demo", "weak_aspects": ["noise"]}}
WEAK_SERVICE = {"id": "m-service", "slug": "service-weak", "display_name": "Slow Place",
                "display_name_zh": "", "district": "Central",
                "category_primary": "restaurant", "tags": ["restaurant"],
                "avg_price_hkd": 120,
                "attributes": {"data_origin": "demo", "weak_aspects": ["service"]}}
CLEAN = {"id": "m-clean", "slug": "clean-place", "display_name": "Fine Place",
         "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
         "tags": ["restaurant"], "avg_price_hkd": 120, "attributes": {"data_origin": "demo"}}


def test_the_fixture_lane_excludes_the_merchant_weak_at_the_refused_aspect():
    rows = [dict(WEAK_NOISE), dict(WEAK_SERVICE), dict(CLEAN)]
    kept = {r["slug"] for r in S._filter_static(rows, "", {"avoid": ["noise"]})}
    assert kept == {"service-weak", "clean-place"}, (
        f"avoiding noise kept {sorted(kept)} - the weakness list is not read")


def test_membership_not_substring():
    """A merchant weak at `service` is not weak at `noise`, and vice versa."""
    rows = [dict(WEAK_NOISE), dict(WEAK_SERVICE)]
    kept = {r["slug"] for r in S._filter_static(rows, "", {"avoid": ["queue"]})}
    assert kept == {"noise-weak", "service-weak"}, (
        f"a refusal naming queue excluded {sorted({'noise-weak', 'service-weak'} - kept)} - "
        f"the aspect list is being read as a substring")


def test_the_offering_row_carries_the_merchants_own_list():
    offering = {"id": "o1", "merchant_id": "m-noise", "name": "Set Lunch", "name_zh": "",
                "description": "", "price_amount": 88, "attributes": {},
                "merchant_weak_aspects": ["noise"]}
    assert S._static_avoids(offering, ["noise"]) is True
    assert S._static_avoids(offering, ["queue"]) is False, (
        "an offering was excluded on a merchant weakness the refusal did not name")


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
            b = S.PostgresBackend(db)
            rows = await b.merchant_candidates(**dict(common, embedding=None))
            carriers = {}
            for word, aspect in (("noise", "noise"), ("queue", "waiting_time")):
                carriers[word] = {r["slug"] for r in rows
                                  if aspect in ((r.get("attributes") or {})
                                                .get("weak_aspects") or [])}
            kept = {}
            for word in ("noise", "queue", "smoking"):
                kept[word] = {r["slug"] for r in await b.merchant_candidates(
                    **dict(common, embedding=None, filters={"avoid": [word]}))}
            every_offering = await b.offering_candidates(**dict(common))
            kept_offering = await b.offering_candidates(
                **dict(common, filters={"avoid": ["noise"]}))
            return rows, carriers, kept, every_offering, kept_offering
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live
def test_the_corpus_records_the_aspects_two_of_the_refusals_name(plane):
    _rows, carriers, _kept, _eo, _ko = plane
    assert carriers["noise"], "no published merchant records a noise weakness"
    assert carriers["queue"], "no published merchant records a waiting_time weakness"


@live
def test_avoiding_noise_drops_exactly_the_merchants_weak_at_it(plane):
    rows, carriers, kept, _eo, _ko = plane
    expected = {r["slug"] for r in rows} - carriers["noise"]
    assert kept["noise"] == expected, (
        f"avoid=noise: dropped {len(rows) - len(kept['noise'])} merchant(s) and the corpus "
        f"names {len(carriers['noise'])}; "
        f"kept-but-weak {sorted(kept['noise'] & carriers['noise'])[:3]}")


@live
def test_the_queue_refusal_speaks_the_corpus_word(plane):
    rows, carriers, kept, _eo, _ko = plane
    expected = {r["slug"] for r in rows} - carriers["queue"]
    assert kept["queue"] == expected, (
        f"avoid=queue: dropped {len(rows) - len(kept['queue'])} merchant(s) and the corpus "
        f"names {len(carriers['queue'])} waiting_time-weak; the bridge is not being read")


@live
def test_smoking_drops_nothing_because_the_corpus_writes_no_such_fact(plane):
    rows, _carriers, kept, _eo, _ko = plane
    assert kept["smoking"] == {r["slug"] for r in rows}, (
        "avoid=smoking dropped rows on a fact the generator never writes - the honest answer "
        "is that this refusal has no fact to exclude")


@live
def test_the_offering_lane_excludes_the_weak_merchants_offerings(plane):
    """The other lane reads the same merchant list, through the column it carries."""
    rows, carriers, _kept, every_offering, kept_offering = plane
    weak_ids = {str(r["id"]) for r in rows if r["slug"] in carriers["noise"]}
    expected = {str(o["id"]) for o in every_offering
                if str(o.get("merchant_id")) not in weak_ids}
    got = {str(o["id"]) for o in kept_offering}
    assert got == expected, (
        f"avoid=noise: the offering lane kept {len(got)} of {len(every_offering)} and the "
        f"merchant list predicts {len(expected)}")
