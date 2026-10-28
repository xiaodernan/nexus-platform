"""D598 - a refusal of noise read the corpus's list and not its second spelling.

D595 joined `avoid=["noise"]` to `weak_aspects`, the LIST the seed writes, and measured
470 -> 455. The same fact has a second spelling in the same corpus: `generate.py` writes
`lively_ambience` exactly when `aspect_mean["noise"] < 3.0`, so a TRUE value means the merchant
is noisy. Measured on the live plane (2026-10-29): `weak_aspects` names `noise` on **15** of
470 published merchants, the attribute is true on **12**, and the union is **16** - one merchant,
`nori-veranda-0512`, carries only the attribute. A refusal of noise therefore kept a merchant the
corpus calls noisy, and its 7 offerings with it (4,568 -> 4,561 on the offering lane).

The join stays one vocabulary read by both lanes: `categories.aspect_attributes` maps the
lexin's constraint value to the boolean attribute names that mean the same weakness, the SQL
avoid clause grows one `m.attributes @> '{"<name>": true}'` leg PER name (so refusing two words
is an OR of two facts, not a demand that one row carry both), and `_filter_static` reads the
same map. The offering SELECT carries the merchant's boolean value as
`merchant_lively_ambience`, the way it already carries `merchant_weak_aspects`, because the live
clause reads `m.attributes` on both lanes.

What this does NOT claim: `lively_ambience` is a fact about noise, not about crowds or waiting
time. Only a refusal of noise reads it; `queue` still answers through `waiting_time`, and
`smoking` still answers nothing because the corpus writes no smoking fact.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.categories import aspect_attributes
from nexus_ai.search.sql import build_merchant_query

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TENANT = S.DEFAULT_TENANT_ID


def test_the_second_spelling_is_named_for_noise_and_nothing_else():
    assert aspect_attributes("noise") == ["lively_ambience"]
    for word in ("queue", "smoking", "seafood", "quiet"):
        assert aspect_attributes(word) == [], (
            f"{word} was given an attribute fact the corpus does not write for it")


def test_the_live_clause_reads_the_attribute_per_name():
    q = build_merchant_query(tenant_id=TENANT, text=None, embedding=None,
                             filters={"avoid": ["noise"]})
    assert q.sql.count("m.attributes @>") == 1, (
        "the attribute leg is not in the WHERE - the refusal never asks for the spelling")
    assert '{"lively_ambience": true}' in [str(v) for v in q.params], (
        "the attribute fact is not bound as a value")
    assert "lively_ambience" not in q.sql, (
        "an attribute name was concatenated into the SQL - values are bound, never inlined")
    plain = build_merchant_query(tenant_id=TENANT, text=None, embedding=None,
                                 filters={"avoid": ["queue"]})
    assert "m.attributes @>" not in plain.sql, (
        "a queue refusal grew the noise attribute leg")


def test_the_fixture_lane_excludes_the_row_whose_only_spelling_is_the_attribute():
    rows = [
        {"id": "m1", "slug": "lively", "display_name": "Lively Place", "display_name_zh": "",
         "district": "Central", "category_primary": "bar", "tags": ["bar"],
         "avg_price_hkd": 120, "attributes": {"lively_ambience": True}},
        {"id": "m2", "slug": "calm", "display_name": "Calm Place", "display_name_zh": "",
         "district": "Central", "category_primary": "cafe", "tags": ["cafe"],
         "avg_price_hkd": 80, "attributes": {"lively_ambience": False}},
        {"id": "m3", "slug": "silent", "display_name": "Silent Place", "display_name_zh": "",
         "district": "Central", "category_primary": "cafe", "tags": ["cafe"],
         "avg_price_hkd": 90, "attributes": {}},
    ]
    kept = {r["slug"] for r in S._filter_static([dict(r) for r in rows], "", {"avoid": ["noise"]})}
    assert kept == {"calm", "silent"}, (
        f"avoiding noise kept {sorted(kept)} - a true `lively_ambience` is the weakness")


def test_a_false_or_absent_attribute_is_not_evidence_of_noise():
    rows = [{"id": "m2", "slug": "calm", "display_name": "Calm Place", "display_name_zh": "",
             "district": "Central", "category_primary": "cafe", "tags": ["cafe"],
             "avg_price_hkd": 80, "attributes": {"lively_ambience": False}},
            {"id": "m3", "slug": "silent", "display_name": "Silent Place",
             "display_name_zh": "", "district": "Central", "category_primary": "cafe",
             "tags": ["cafe"], "avg_price_hkd": 90, "attributes": {}}]
    assert len(S._filter_static([dict(r) for r in rows], "", {"avoid": ["noise"]})) == 2


def test_the_offering_row_reads_the_merchants_attribute_it_carries():
    base = {"id": "o1", "merchant_id": "m1", "name": "Set Lunch", "name_zh": "",
            "description": "", "price_amount": 88, "attributes": {}}
    assert S._static_avoids(dict(base, merchant_lively_ambience=True), ["noise"]) is True
    assert S._static_avoids(dict(base, merchant_lively_ambience=False), ["noise"]) is False
    assert S._static_avoids(dict(base, merchant_lively_ambience=True), ["queue"]) is False, (
        "an offering was excluded on the noise fact for a refusal that named queue")


live = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    common = dict(tenant_id=TENANT, text=None, geo=None, radius_m=None, limit=100000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            b = S.PostgresBackend(db)
            rows = await b.merchant_candidates(**dict(common, embedding=None))
            kept = await b.merchant_candidates(**dict(common, embedding=None,
                                                     filters={"avoid": ["noise"]}))
            every_offering = await b.offering_candidates(**dict(common))
            kept_offering = await b.offering_candidates(
                **dict(common, filters={"avoid": ["noise"]}))
            return rows, kept, every_offering, kept_offering
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _spellings(row):
    attrs = row.get("attributes") or {}
    weak = "noise" in (attrs.get("weak_aspects") or [])
    lively = attrs.get("lively_ambience") is True
    return weak, lively


@live
def test_the_corpus_carries_both_spellings_and_one_row_has_only_the_attribute(plane):
    rows, _kept, _eo, _ko = plane
    weak = {r["slug"] for r in rows if _spellings(r)[0]}
    lively = {r["slug"] for r in rows if _spellings(r)[1]}
    assert len(weak) == 15, sorted(weak)
    assert len(lively) == 12, sorted(lively)
    assert len(weak | lively) == 16, (
        f"the union moved: {sorted(weak | lively)}")
    assert lively - weak, (
        "every lively row also names noise - the second spelling would be redundant, and this "
        "door's premise would be wrong")


@live
def test_avoiding_noise_drops_the_union_of_both_spellings(plane):
    rows, kept, _eo, _ko = plane
    union = {r["slug"] for r in rows if any(_spellings(r))}
    assert {r["slug"] for r in kept} == {r["slug"] for r in rows} - union, (
        f"avoid=noise kept {len(kept)} of {len(rows)} and the two spellings name {len(union)}")


@live
def test_the_offering_lane_drops_the_union_merchants_offerings(plane):
    rows, _kept, every_offering, kept_offering = plane
    union_ids = {str(r["id"]) for r in rows if any(_spellings(r))}
    expected = {str(o["id"]) for o in every_offering
                if str(o.get("merchant_id")) not in union_ids}
    assert {str(o["id"]) for o in kept_offering} == expected, (
        f"offering lane kept {len(kept_offering)} of {len(every_offering)}; "
        f"the union predicts {len(expected)}")
