"""D608 - the nearest MTR station the geo lane fetches never reaches the answer.

`docs/VISION.md:45` names the consumer surface in Hong Kong terms: "district/area + **MTR
proximity**". `docs/DATABASE.md:65` files that fact as columns of the location record, and the
platform's own merchant surface ships them (`MerchantContentController.java:853-855`,
`MerchantRepository.java:138`). The AI lane fetches them into the merchant row and prints nothing:

    reader of mtr_station / mtr_walk_min in nexus_ai   0 (census over every module but the builder,
                                                       `tmp/d608_census.py`)
    a real geo search (`咖啡店`, Central, r=3000, limit 20,
    `tmp/d608_mtr_probe.py`)                     station on 20 of 20 rows, walk_min on 20 of 20
    the same request through the shipped pipeline (`tmp/d608_pipeline_probe.py`)
                                                       0 of 6 cards say anything about a station

What the card prints instead is `距離你 470m` with `travel_minutes = meters / 80` — an estimate of
the walk FROM THE USER, computed from straight-line distance (`cards.py:85`, and the web renders
it: `apps/web/src/lib/facts.ts:77`). The recorded minutes are the walk FROM THE STATION, a
different question, and for the first card of that page they are 14 against an estimate of 6.
Neither number is wrong; only one of them is a fact the merchant keeps, and it is the one that
goes unspoken.

The plane is not shy about this fact. Measured (`tmp/d608_mtr_probe.py`, 2026-10-29): **684 of 684
`locations` rows carry both** a station and walk minutes, all **470 published merchants** with a
primary location have both, `mtr_walk_min` spans 2..25, and the three spellings of the same
threshold agree exactly - 132 merchants are within five minutes by the column, by the
`attributes->'mtr_within_5min'` trait the ranking lane already reads (`service.py:1390`) and by the
`mtr-5min` tag, with **0 disagreements**. So printing the number contradicts nothing the answer
already claims.

The second half is a lane asymmetry, the D449/D596 shape: the offering lane's geo projection is
`loc.meters, loc.district` (`build_offering_query`'s geo block) while the merchant lane's is
five columns including both transit ones (`sql.py:269-270`). An offering card - a class, a
treatment, an experience, which is what a bookable user walks to - cannot carry the fact even
after the card learns to read it, and
the measurement above is a card-type-blind claim about "the row".

**What this unit does not touch, and says so.** The stored `address` facts (684, all
`source='merchant'`, agreeing with the columns 684/684 on district) are filed under
`subject_type='location'` and keyed by `locations.id`, while `facts_for` asks
`WHERE subject_id = ANY(...)` with the candidate subjects and `_fact_for` looks the address fact up
under the merchant's own uuid (`cards.py:447`) - measured `bundle.get("address", merchant)` = None
on every card of that live page (`tmp/d608_district_probe.py`), which is why no live card raises
the `district_match` bullet it already has copy for. Repairing that means either widening the fact
load to location subjects or re-filing the facts, and neither is this unit's evidence to carry; it
is filed in PLAN with the counts. The district still reaches the user, ungrounded, through the
subtitle (`cards.py:495`) - so the loss there is the citation, not the word.

`_NO_FACT_REASON_LABELS` holds exactly one label, `sponsored`, by an explicit §18 decision: every
claimed match must trace to a fact id. So the transit bullet is raised only when a fact backs it,
and the door checks it survives `drop_ungrounded_reasons` and appears in `card.facts` - the list
the web filters bullets by (`facts.ts:112`).
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from nexus_ai.nlu import canonical, lexicon
from nexus_ai.search import sql as SQL
from nexus_ai.search.cards import (
    REASON_COPY,
    _reason_text,
    build_card,
    drop_ungrounded_reasons,
    travel_minutes,
)
from nexus_ai.search.ranking import Candidate
from nexus_ai.trust.facts import FactBundle

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = "00000000-0000-0000-0000-000000000001"
#: Central, the product's own default consumer point, and a radius that answers.
GEO = (22.282, 114.156)
RADIUS = 3000
NOW = datetime.now(timezone.utc).replace(microsecond=0)
LOCALES = ("zh-HK", "zh-CN", "en")

MERCHANT = uuid4()
SUBJECT = uuid4()


def _merchant_row(**over):
    """A row shaped like `build_merchant_query`'s output under a geo request."""
    row = {"id": MERCHANT, "subject_id": str(MERCHANT), "subject_type": "merchant",
           "slug": "test-merchant", "display_name": "Test Merchant",
           "display_name_zh": "測試商戶", "category_primary": "cafe",
           "avg_price_hkd": 120.0, "rating_agg": 4.2, "review_count": 30,
           "data_origin": "demo", "attributes": {}, "tags": [],
           "meters": 468.0, "district": "Central", "address_line1": "82 Lok Way, Central",
           "mtr_station": "Central", "mtr_walk_min": 14}
    row.update(over)
    return row


def _offering_row(**over):
    row = {"id": SUBJECT, "subject_id": str(SUBJECT), "subject_type": "offering",
           "merchant_id": MERCHANT, "merchant_id_key": str(MERCHANT), "slug": "test-service",
           "name": "Test service", "kind": "service", "price_amount": 300.0, "currency": "HKD",
           "price_model": "fixed", "price_source": "merchant", "avg_price_hkd": 300.0,
           "data_origin": "demo", "rating_agg": 4.0, "review_count": 12,
           "attributes": {}, "tags": [], "merchant_name": "Test Merchant",
           "meters": 468.0, "district": "Central",
           "mtr_station": "Central", "mtr_walk_min": 14}
    row.update(over)
    return row


def _candidate(row):
    return Candidate(subject_type=row["subject_type"], subject_id=str(row["subject_id"]),
                     merchant_id=str(row.get("merchant_id") or row["id"]),
                     price=row.get("price_amount") or row.get("avg_price_hkd"),
                     rating=row.get("rating_agg"), rating_count=row.get("review_count") or 0,
                     distance_m=row.get("meters"), district=row.get("district"),
                     category=row.get("category_primary"),
                     raw={"row": row, "as_of": NOW})


def _card(row, *, locale="zh-HK"):
    cand = _candidate(row)
    bundle = FactBundle()
    card = build_card(cand, None, bundle, locale=locale, query="咖啡店")
    return card, bundle


def _transit(card):
    return [r for r in (card.ai_match.reasons if card.ai_match else [])
            if r.label == "mtr_proximity"]


# --------------------------------------------------------------- the card raises the fact
def test_the_transit_minutes_a_row_carries_reach_the_card():
    card, _bundle = _card(_merchant_row())
    bullet = _transit(card)
    assert bullet, (
        "the row handed the builder mtr_station='Central' and mtr_walk_min=14 and the answer "
        f"says nothing about a station: {[r.label for r in card.ai_match.reasons]}. "
        "VISION's consumer surface names MTR proximity; the card's only transit sentence is an "
        "estimate made from straight-line metres.")
    text = bullet[0].text
    assert "Central" in text and "14" in text, (
        f"the bullet reads {text!r} - it has to name the station and the minutes the row stated")


def test_a_row_that_states_no_station_raises_no_bullet():
    for over in ({"mtr_station": None}, {"mtr_walk_min": None},
                 {"mtr_station": ""}, {"mtr_station": None, "mtr_walk_min": None}):
        card, _ = _card(_merchant_row(**over))
        assert not _transit(card), (
            f"a row shaped {over} still printed a transit bullet - §2 refuses a guessed fact, "
            "and half a transit fact is a guess about the other half")


def test_half_a_transit_pair_writes_no_sentence_at_the_copy_lane_too():
    # The card only formats this label when a transit fact exists, so the builder's own guard is
    # already covered by the row above. `_reason_text` is the lane that turns the two columns into
    # a sentence, and `_fact_for` lets it be reached with a fact the ROW did not hand over - a
    # stored `mtr_proximity` cited under a query that carried no geo, the same ladder
    # `district_match` climbs to read a stored address. Half a pair formatted anyway is a
    # sentence about a walk nobody stated (§2), so the copy lane refuses its own half too.
    for over in ({"mtr_station": None}, {"mtr_walk_min": None},
                 {"mtr_station": "", "mtr_walk_min": None}):
        cand = _candidate(_merchant_row(**over))
        for locale in LOCALES:
            text = _reason_text("mtr_proximity", cand, locale=locale, open_state=None,
                                query=None)
            assert text == "", (
                f"a row shaped {over} wrote {text!r} in {locale} - one half of the pair is "
                "missing, so the sentence invents the other")
    full = _reason_text("mtr_proximity", _candidate(_merchant_row()), locale="zh-HK",
                        open_state=None, query=None)
    assert "Central" in full and "14" in full, (
        f"the guard now refuses a complete pair too: {full!r} - this row states both halves")


def test_the_recorded_walk_is_not_printed_as_the_estimated_one():
    card, _ = _card(_merchant_row())
    est = travel_minutes(468.0)
    assert card.distance["travel_minutes"] == est == 6, (
        f"the card's own estimate from 468 straight-line metres is "
        f"{card.distance['travel_minutes']}, not 6 - the estimate is a computed fact and this "
        "door's claim is that it stays separate from the recorded one")
    bullet = _transit(card)
    assert bullet, "no transit bullet to compare with the estimate"
    assert "14" in bullet[0].text and "6" not in bullet[0].text, (
        f"the bullet reads {bullet[0].text!r}: the recorded walk from the station (14) and the "
        "estimated walk from the user (6) are different questions, and laundering one into the "
        "other is how a card ends up printing a number nobody stated")


@pytest.mark.parametrize("locale", LOCALES)
def test_the_transit_bullet_is_written_in_the_locale_the_user_asked_in(locale):
    texts = {}
    for asked in LOCALES:
        card, _ = _card(_merchant_row(), locale=asked)
        bullet = _transit(card)
        assert bullet, f"locale {asked} got no transit bullet at all"
        texts[asked] = bullet[0].text
    assert len(set(texts.values())) == 3, (
        f"the three locales print one sentence: {texts} - zh-HK is Traditional, zh-CN Simplified "
        "and English is English, and D605's defect was a notice that ignored the request")
    text = texts[locale]
    assert "Central" in text, f"locale {locale} dropped the station: {text!r}"
    assert "14" in text, f"locale {locale} dropped the minutes: {text!r}"


def test_the_simplified_script_never_enters_a_zh_HK_sentence():
    """D606 built this rule for the web plane with a gate; the AI lane's own copy had none.

    The character knowledge is derived from the two tables the product already keeps, so this row
    widens when a pair is taught and holds nothing extra of its own.
    """
    simp = {s for _t, s in lexicon._TRAD_SIMP_PAIRS}
    simp |= {k for k, v in canonical.CANONICAL_FORMS.items()
             if len(k) == 1 and len(v) == 1 and k != v}
    offenders = {label: {ch for ch in copy["zh-HK"] if ch in simp}
                 for label, copy in REASON_COPY.items()
                 if "zh-HK" in copy and any(ch in simp for ch in copy["zh-HK"])}
    assert not offenders, (
        f"these zh-HK sentences carry characters the product's own pair tables call Simplified: "
        f"{offenders}")


def test_every_bullet_the_card_can_raise_has_copy_in_every_locale_it_admits():
    missing = {label: sorted(set(LOCALES) - set(copy))
               for label, copy in REASON_COPY.items() if set(LOCALES) - set(copy)}
    assert not missing, (
        f"_reason_text indexes REASON_COPY[label][locale] after folding the request locale "
        f"into these three, so a label missing one is a KeyError or a wrong-language "
        f"sentence: {missing}")


def test_the_bullet_survives_the_wire_gate_and_sits_in_the_cards_own_facts():
    card, _bundle = _card(_merchant_row())
    kept, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0, (
        f"the transit bullet was raised by the builder and deleted by the §18 gate ({dropped}) - "
        "an ungrounded claim is exactly what that gate is for")
    bullet = _transit(kept)
    assert bullet and bullet[0].fact_id is not None
    fact_ids = {f.fact_id for f in kept.facts}
    assert bullet[0].fact_id in fact_ids, (
        f"the bullet cites {bullet[0].fact_id} and the card's own facts[] holds "
        f"{sorted(str(i) for i in fact_ids)} - the web filters bullets by that list "
        "(apps/web/src/lib/facts.ts:112), so a fact in the bundle only is not on the card")
    fact = next(f for f in kept.facts if f.fact_id == bullet[0].fact_id)
    assert fact.attribute == "mtr_proximity", f"the cited fact is a {fact.attribute} fact"
    assert fact.value.get("station") == "Central" and fact.value.get("walk_min") == 14, (
        f"the citation vouches for {fact.value!r} while the card prints {bullet[0].text!r}")


# ------------------------------------------------------------------ the two lanes, one row
def test_the_offering_lane_carries_the_same_geo_projection_as_the_merchant_lane():
    """One product, two candidate lanes: the merchant lane fetches the transit pair, the
    offering lane does not fetch it at all, so the claim above cannot be made about a card
    of the type a booking user actually walks to."""
    m_q = SQL.build_merchant_query(tenant_id=TENANT, text="咖啡店", embedding=None,
                                   geo=GEO, radius_m=RADIUS, limit=5)
    o_q = SQL.build_offering_query(tenant_id=TENANT, text="下午茶",
                                   geo=GEO, radius_m=RADIUS, limit=5)
    for name in ("mtr_station", "mtr_walk_min"):
        assert name in m_q.sql, f"the merchant lane no longer projects {name}"
        assert name in o_q.sql, (
            f"the offering lane never projects {name} - its geo block is "
            "`loc.meters, loc.district` while the merchant's is five columns")


def test_the_offering_card_raises_the_same_bullet_from_the_same_columns():
    card, _ = _card(_offering_row())
    bullet = _transit(card)
    assert bullet, (
        "an offering row carrying the two columns printed no transit bullet: the card builder "
        f"raised {[r.label for r in card.ai_match.reasons]}")
    assert "Central" in bullet[0].text and "14" in bullet[0].text


# ---------------------------------------------------------------------------- the live plane
@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set")
    import nexus_ai.search.service as S
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out: dict[str, object] = {}
            m_q = SQL.build_merchant_query(tenant_id=TENANT, text="咖啡店", embedding=None,
                                           geo=GEO, radius_m=RADIUS, limit=20)
            out["merchant_rows"] = [dict(r) for r in await db.fetch(m_q.sql, *m_q.params)]
            o_q = SQL.build_offering_query(tenant_id=TENANT, text="下午茶",
                                           geo=GEO, radius_m=RADIUS, limit=20)
            out["offering_rows"] = [dict(r) for r in await db.fetch(o_q.sql, *o_q.params)]
            backend = S.PostgresBackend(db)
            cards = {}
            for locale in LOCALES:
                plan = S.SearchPlan(query_text="咖啡店", limit=6, subject_types=("merchant",),
                                    geo=GEO, radius_m=RADIUS)
                got, _resp, _bundle, _scored = await S.search(backend=backend, plan=plan,
                                                              locale=locale)
                cards[locale] = got
            out["cards"] = cards
            out["census"] = {
                r["n_loc"]: r for r in await db.fetch(
                    "select count(*)::int n_loc, "
                    "  count(*) filter (where mtr_station is not null "
                    "    and mtr_station <> '')::int station, "
                    "  count(*) filter (where mtr_walk_min is not null)::int walk_min, "
                    "  min(mtr_walk_min)::int lo, max(mtr_walk_min)::int hi "
                    "from locations")}
            agree = await db.fetchrow(
                "select count(*)::int known, "
                "  count(*) filter (where (l.mtr_walk_min <= 5) is distinct from "
                "    ((m.attributes ? 'mtr_within_5min') "
                "     and (m.attributes->>'mtr_within_5min')::bool))::int disagree, "
                "  count(*) filter (where l.mtr_walk_min <= 5)::int by_column, "
                "  count(*) filter (where (m.attributes->>'mtr_within_5min')::bool)::int by_trait, "
                "  count(*) filter (where 'mtr-5min' = any(m.tags))::int by_tag "
                "from merchants m join locations l on l.merchant_id = m.id and l.is_primary "
                "where m.status = 'published'")
            out["agree"] = dict(agree)
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live_only
def test_the_live_merchant_lane_hands_every_row_the_station_and_the_minutes(plane):
    rows = plane["merchant_rows"]
    assert rows, "the lane answered nothing, so the claim below is unmeasured"
    missing = [str(r.get("id")) for r in rows
               if not r.get("mtr_station") or r.get("mtr_walk_min") is None]
    assert not missing, (
        f"{len(missing)} of {len(rows)} rows a real geo search returned carry no station or no "
        "recorded walk - the fact the card cannot print is at least present to fetch")


@live_only
def test_the_live_offering_lane_hands_the_same_two_columns(plane):
    rows = plane["offering_rows"]
    assert rows, "the offering lane answered nothing for 下午茶 near Central"
    absent = [k for k in ("mtr_station", "mtr_walk_min") if k not in rows[0]]
    assert not absent, (
        f"the offering row has no {absent} key at all: the merchant lane's geo block projects "
        "five columns and the offering lane's projects two, so one product answers one question "
        "with two row shapes")


@live_only
def test_a_live_geo_answer_names_the_station_it_was_handed(plane):
    cards = plane["cards"]["zh-HK"]
    assert cards, "the live pipeline returned no card"
    with_bullet = [c for c in cards if _transit(c)]
    assert len(with_bullet) == len(cards), (
        f"{len(with_bullet)} of {len(cards)} live cards name a station, while all "
        f"{len(cards)} rows carry one; the bullets on the others are "
        f"{[sorted(r.label for r in c.ai_match.reasons) for c in cards if not _transit(c)][:2]}")
    first = _transit(cards[0])[0]
    assert "min" not in first.text and "分鐘" in first.text, (
        f"a zh-HK reader got {first.text!r}")


@live_only
def test_the_three_spellings_of_the_transit_threshold_agree(plane):
    """The bullet is safe to print because it cannot contradict the trait the ranker reads."""
    agree = plane["agree"]
    assert agree["known"] == 470, (
        f"this door measured 470 published merchants with a primary location; the plane now has "
        f"{agree['known']} and the counts quoted here need re-measuring")
    assert agree["disagree"] == 0, (
        f"the recorded minutes, the `mtr_within_5min` trait `service.py:1390` reads and the "
        f"`mtr-5min` tag disagree for {agree['disagree']} merchants "
        f"(column {agree['by_column']} / trait {agree['by_trait']} / tag {agree['by_tag']}) - "
        "printing the number would then contradict the ranking")


@live_only
def test_the_plane_records_the_transit_fact_for_every_location_it_has(plane):
    census = plane["census"]
    row = next(iter(census.values()))
    assert row["station"] == row["n_loc"] == row["walk_min"], (
        f"{row['n_loc']} locations, {row['station']} with a station, {row['walk_min']} with "
        "walking minutes - the door's claim that the fact is not sparse has to stay true")
    assert 2 <= row["lo"] and row["hi"] <= 25, (
        f"mtr_walk_min spans {row['lo']}..{row['hi']}; the range measured on 2026-10-29 was "
        "2..25 and a wider one is a data change, not a door change")
