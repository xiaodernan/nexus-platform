"""D609 - the district a card prints is filed under a subject the answer never loads.

D608 gave the card the walk from the station; the other half of the same sentence in
`docs/VISION.md:45` - "district/area + MTR proximity" - is a word the card prints with nothing
behind it. `_subtitle` renders `· {district}` from the row's `loc.district` and `REASON_COPY`
holds a `district_match` sentence in all three locales, which is copy no card can raise: the
stored `address` fact that would ground it is keyed to a row the pipeline never asks for.

Measured on the live plane (`tmp/d609_district_cite_probe.py`, 2026-10-29), by
`subject_type` over the whole `facts` table:

    address        location   n=684    merchant-keyed=0     location-keyed=684
    cuisine        merchant   n=520    merchant-keyed=520   location-keyed=0
    opening_hours  merchant   n=520    ...
    price          merchant   n=520    /  offering n=1,564
    rating         merchant   n=520    /  offering n=1,207
    capacity       offering   n=157

So `address` is the ONE attribute this plane files under a third kind of subject, and the load
has no way to reach it: `facts_for` asks `WHERE subject_id = ANY(...)` (`sql.py:613`) with
`subject_ids`, which `search()` fills from the candidate rows' own ids (`service.py:985`), and
the geo LATERAL that produces the district selects `l.id` inside its subquery (`sql.py:276`) and
projected five other columns from it - never the id. The location's uuid is on no list the load
could ask for, so this is not a filter that drops the row: the row was never fetched.

What the shipped pipeline then answers, both lanes, `咖啡店`/`下午茶` near Central, limit 6:

    cards printing a district        6 of 6      (merchant)  /  6 of 6  (offering)
    cards raising the district bullet 0 of 6      /  0 of 6
    cards carrying an address fact    0 of 6      /  0 of 6
    address facts anywhere in the bundle          0

And the fact is there to fetch: for the 20 merchants a real geo search returns, the location its
own LATERAL picks (bbox + haversine + `ORDER BY meters ASC NULLS LAST LIMIT 1`) has an `address`
fact 20 of 20 times, and the fact's district equals the column's 20 of 20.

**Why the key has to be the location's id and not the merchant's.** 520 merchants keep 684
locations; 77 of them have locations in more than one district. Among the 145 published
multi-location merchants of this tenant, **133** have their NEAREST location in a different
district from their PRIMARY one (松屋: Ma On Shan / Tai Wai; 喜薈: Central / Stanley). A
merchant-level lookup would therefore print a district the card is not showing for 133 merchants
- a wrong citation, not a missing one - which is why the repair projects `loc.id AS location_id`
and cites the fact of the row the district actually came from.

**What this unit does not touch, and says so.** (1) Ranking: `facts_by_subject` buckets a fact
under the fact's OWN `subject_id`, and `Candidate.freshness` reads
`facts_by_subject.get(subject_id)` (`service.py:808`) - the merchant's own list. Location facts
join the bundle and no score, and a row below pins that the widening moves no card's
`score_breakdown`. Whether a location's clock belongs in its merchant's freshness contribution
is a ranking decision with its own evidence to gather. (2) `_disputed_attributes` still resolves
conflicts over the card's own subject; measured exactly 1 `address` fact per location (684 facts
over 684 locations), so no conflict exists to surface yet. (3) The comparison grid synthesises
its own merchant-keyed `address` fact when it finds none
(`apps/ai/nexus_ai/api/routes_discover.py:325-330`, D401) - a second shape of the same fact on a
second surface, filed in PLAN rather than folded in here.

**The citation rule, and why it is strict.** A row that names a location cites that location's
fact and no other. Falling back to a merchant-level `address` fact would let the card vouch for
`位於 Central` with a record that says Stanley - 77 merchants keep locations in more than one
district, so the two can and do disagree. A row that names no location cites its own subject,
which is where the in-memory demo lane files the same attribute
(`apps/ai/nexus_ai/api/demo_data.py:151`).

**What the widening costs** (`tmp/d609_cost_probe.py`, same day). A merchant geo page's candidate
list is 54 rows naming 54 distinct locations, so its one fact fetch goes from 54 ids to 108; an
offering page is 60 rows over 38 distinct locations, so 60 to 98 - the ids are deduplicated, and a
page with no geo still asks for exactly its own 60. Each location holds exactly one address fact
(684 facts over 684 distinct subjects, `locs_with_two = 0`), so no card can cite two.

**What the widening gives the verifier** - a disclosure, not a win. `build_ground_set` feeds every
scalar of every bundle fact, so a merchant geo page's ground set goes from 1,078 numbers / 323
strings to 1,186 / 600: the district words become traceable, and so do 54 lat/lng pairs, under
`TOLERANCE[NUMBER_KIND] = (0.01, 0.5)` - a number a model invents within half a degree of a real
latitude now reads as grounded. Filed in PLAN with these counts; this unit does not change the
tolerance table.

**The clock, kept honest.** All 684 are observed at 2026-09-22 03:00 UTC against
`FRESHNESS_TTL["address"] = 30 days`, so by the time this lands every one of them is past its
TTL, while the stored `stale` column says `False` (684 of 684). `facts_from_rows` re-evaluates -
"the DB flag never overrides the clock" (D589's rule) - so all 54 facts a live geo page loads
arrive `stale=True`, and the bullet still rises: §18 asks a claim to trace to a fact id, and this
fact is the merchant's own statement of where it is (`source='merchant'` on 684 of 684, with the
plane's own confidences 0.8/0.9/0.95/0.98/1.0). Whether a stale NON-price attribute should also
carry §5's surfaced warning is filed in PLAN, not decided here.

`_NO_FACT_REASON_LABELS` still holds exactly one label, `sponsored`, so the district bullet is
raised only when a fact backs it - and a row below pins that a row which prints a district
without stating a location cites nothing instead of inventing one.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest

import nexus_ai.search.service as S
from nexus_ai.search import sql as SQL
from nexus_ai.search.cards import drop_ungrounded_reasons
from nexus_ai.trust.freshness import FRESHNESS_TTL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = "00000000-0000-0000-0000-000000000001"
GEO = (22.282, 114.156)
RADIUS = 3000
NOW = datetime.now(timezone.utc).replace(microsecond=0)
#: the seed stamped every address fact at one instant; 36 days is past the 30-day TTL.
SEED_CLOCK = NOW - timedelta(days=36)
LOCALES = ("zh-HK", "zh-CN", "en")

MERCHANT = uuid4()
LOCATION = uuid4()
OTHER_LOCATION = uuid4()
OFFERING = uuid4()


def _merchant_row(**over):
    """A row shaped like `build_merchant_query`'s output under a geo request."""
    row = {"id": MERCHANT, "subject_id": str(MERCHANT), "subject_type": "merchant",
           "slug": "central-cafe", "display_name": "Central Cafe",
           "display_name_zh": "中區咖啡", "category_primary": "cafe",
           "avg_price_hkd": 120.0, "rating_agg": 4.2, "review_count": 30,
           "data_origin": "demo", "attributes": {}, "tags": ["咖啡店"],
           "meters": 468.0, "district": "Central", "address_line1": "82 Lok Way, Central",
           "location_id": str(LOCATION), "mtr_station": "Central", "mtr_walk_min": 14}
    row.update(over)
    return row


def _offering_row(**over):
    row = {"id": OFFERING, "subject_id": str(OFFERING), "subject_type": "offering",
           "merchant_id": MERCHANT, "merchant_id_key": str(MERCHANT), "slug": "afternoon-tea",
           "name": "Afternoon tea", "kind": "experience", "price_amount": 300.0,
           "currency": "HKD", "price_model": "fixed", "price_source": "merchant",
           "avg_price_hkd": 300.0, "data_origin": "demo", "rating_agg": 4.0,
           "review_count": 12, "attributes": {}, "tags": ["下午茶"],
           "merchant_name": "Central Cafe", "meters": 468.0, "district": "Central",
           "address_line1": "82 Lok Way, Central", "location_id": str(LOCATION),
           "mtr_station": "Central", "mtr_walk_min": 14}
    row.update(over)
    return row


def _address_fact(subject: Any, district: str, *, merchant: Any = MERCHANT,
                  subject_type: str = "location", observed_at: Any = SEED_CLOCK,
                  stored_stale: bool = False, **over):
    """A `facts` row shaped like `facts_for`'s projection, keyed to `subject`."""
    row = {"fact_id": str(uuid4()), "subject_type": subject_type, "subject_id": str(subject),
           "merchant_id": str(merchant), "attribute": "address",
           "value": {"district": district, "line1": f"82 Lok Way, {district}",
                     "lat": 22.2821, "lng": 114.1562, "synthetic": True},
           "unit": None, "currency": None, "source": "merchant", "source_uri": None,
           "confidence": 0.9, "observed_at": observed_at, "expires_at": None,
           "stale": stored_stale}
    row.update(over)
    return row


class _Recorder(S.StaticBackend):
    """What `search()` actually asks the fact load for, recorded rather than remembered."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fact_calls: list[list[str]] = []

    async def facts(self, subject_ids):
        self.fact_calls.append([str(s) for s in subject_ids])
        return await super().facts(subject_ids)


async def _search(rows, facts=(), *, subject_types=("merchant",), query="咖啡店", now=NOW,
                  locale="zh-HK"):
    backend = _Recorder(merchants=[r for r in rows if r["subject_type"] == "merchant"],
                        offerings=[r for r in rows if r["subject_type"] == "offering"],
                        facts=facts)
    plan = S.SearchPlan(query_text=query, subject_types=subject_types, geo=GEO,
                        radius_m=RADIUS, limit=6, now=now)
    cards, _resp, bundle, _scored = await S.search(backend=backend, plan=plan, locale=locale)
    return cards, bundle, backend


def _district_bullet(card):
    return [r for r in (card.ai_match.reasons if card.ai_match else [])
            if r.label == "district_match"]


# ----------------------------------------------------------- the load can reach the fact
@pytest.mark.parametrize("lane", ("merchant", "offering"))
def test_the_geo_projection_names_the_location_it_cites(lane):
    """The district comes out of the LATERAL; the id of the row it came out of does not."""
    if lane == "merchant":
        asked = SQL.build_merchant_query(tenant_id=TENANT, text="咖啡店", embedding=None,
                                         geo=GEO, radius_m=RADIUS, limit=5)
        no_geo = SQL.build_merchant_query(tenant_id=TENANT, text="咖啡店", embedding=None,
                                          limit=5)
    else:
        asked = SQL.build_offering_query(tenant_id=TENANT, text="下午茶", geo=GEO,
                                         radius_m=RADIUS, limit=5)
        no_geo = SQL.build_offering_query(tenant_id=TENANT, text="下午茶", limit=5)
    assert "AS location_id" in asked.sql, (
        f"the {lane} lane's geo block projects the district but not the row the district is "
        "read from, so no fact load can ever ask for that location by id")
    assert "NULL::uuid AS location_id" in no_geo.sql, (
        f"with no geo request the {lane} lane must state 'no location' as a NULL uuid, not as "
        "an absent key or a coerced one - `_coerce_uuid(None)` answers a derived uuid")


def test_the_fact_load_asks_for_the_location_the_row_selected():
    cards, _bundle, backend = asyncio.run(_search([_merchant_row()], [_address_fact(
        LOCATION, "Central")]))
    assert cards, "the fixture lane answered nothing, so the call below is unmeasured"
    asked = backend.fact_calls[0]
    assert str(MERCHANT) in asked, "the card's own subject must stay in the fetch"
    assert str(LOCATION) in asked, (
        f"the fact load asked for {asked} - the row handed over the location whose district it "
        "prints and the load never names it, so the address fact cannot arrive at all")
    assert asked.count(str(LOCATION)) == 1, (
        f"the location id is asked for {asked.count(str(LOCATION))} times - one page one fetch")


def test_a_page_with_no_location_states_no_extra_subject():
    rows = [_merchant_row(district=None, location_id=None)]
    _cards, _bundle, backend = asyncio.run(_search(rows))
    asked = backend.fact_calls[0]
    assert asked == [str(MERCHANT)], (
        f"a row that states no location widened the fetch to {asked} - a NULL column must add "
        "a read for nothing, and 'None' is not a uuid anyone can cite")


def test_the_district_a_card_prints_resolves_to_the_stored_fact():
    fact_row = _address_fact(LOCATION, "Central")
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row()], [fact_row]))
    card = cards[0]
    bullet = _district_bullet(card)
    assert bullet, (
        f"the card prints {card.subtitle!r} and raises {[r.label for r in card.ai_match.reasons]} "
        "- `REASON_COPY['district_match']` exists in three locales and no card can raise it, "
        "because the address fact that vouches for the district is filed under `locations.id`")
    assert bullet[0].value == "Central" and "Central" in card.subtitle, (
        f"the bullet claims {bullet[0].value!r} while the subtitle reads {card.subtitle!r}")


def test_the_district_sentence_is_written_in_the_locale_the_user_asked_in():
    """D605's shape: the copy exists in three scripts and the lane that raises it must be told
    which one the user asked in."""
    texts = {}
    for asked in LOCALES:
        cards, _b, _ = asyncio.run(_search([_merchant_row()],
                                           [_address_fact(LOCATION, "Central")], locale=asked))
        bullet = _district_bullet(cards[0])
        assert bullet, f"locale {asked} got no district bullet at all"
        texts[asked] = bullet[0].text
    assert len(set(texts.values())) == 3, (
        f"the three locales print one sentence: {texts} - zh-HK is Traditional, zh-CN "
        "Simplified and English is English")
    for locale, text in texts.items():
        assert "Central" in text, f"locale {locale} dropped the district it cites: {text!r}"


# ------------------------------------------------------ the citation is the one on the wire
def test_the_cited_fact_is_on_the_card_the_web_filters_bullets_by():
    fact_row = _address_fact(LOCATION, "Central")
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row()], [fact_row]))
    kept, dropped = drop_ungrounded_reasons(cards[0])
    assert dropped == 0, (
        f"the district bullet was raised by the builder and deleted by the §18 gate ({dropped}) - "
        "an ungrounded claim is exactly what that gate is for")
    bullet = _district_bullet(kept)
    assert bullet and bullet[0].fact_id is not None
    fact_ids = {str(f.fact_id) for f in kept.facts}
    assert str(bullet[0].fact_id) in fact_ids, (
        f"the bullet cites {bullet[0].fact_id} and the card's facts[] holds {sorted(fact_ids)} - "
        "the web filters bullets by that list (apps/web/src/lib/facts.ts:112)")
    fact = next(f for f in kept.facts if str(f.fact_id) == str(bullet[0].fact_id))
    assert fact.attribute == "address" and fact.value["district"] == "Central", (
        f"the citation vouches for {fact.value!r} while the card prints {kept.subtitle!r}")


def test_the_nearest_location_is_the_one_cited_not_another_district_of_the_same_merchant():
    """77 merchants keep locations in more than one district, and 133 of the 145 published ones
    have the nearest in a different district from the primary - so a merchant-level key would
    cite a district the card is not printing."""
    near = _address_fact(LOCATION, "Central")
    far = _address_fact(OTHER_LOCATION, "Stanley")
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row()], [near, far]))
    bullet = _district_bullet(cards[0])
    assert bullet, "no district bullet to compare"
    assert str(bullet[0].fact_id) == str(near["fact_id"]), (
        f"the card prints Central and cites {bullet[0].fact_id}; the row's own location "
        f"({LOCATION}) is vouched by {near['fact_id']} and the merchant's other location "
        f"({OTHER_LOCATION}, Stanley) by {far['fact_id']} - citing the wrong location is worse "
        "than citing nothing, because it looks grounded")
    assert "Stanley" not in cards[0].subtitle, (
        f"the subtitle reads {cards[0].subtitle!r} - the district shown must be the location the "
        "user walks to, not the merchant's primary record")


def test_a_row_naming_a_location_cites_no_other_subjects_address_fact():
    """The strict half of the same rule: a location with no fact of its own cites nothing, rather
    than a merchant-level fact that happens to name some district - a citation has to vouch for
    the word printed, not for any word of the same shape."""
    merchant_fact = _address_fact(MERCHANT, "Stanley", subject_type="merchant")
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row()], [merchant_fact]))
    assert not _district_bullet(cards[0]), (
        f"the row named {LOCATION}, which holds no address fact, and the card cited "
        f"{cards[0].ai_match.reasons} - reaching back to the merchant's fact would print "
        "'位于 Central' under a citation that says Stanley")


def test_two_cards_on_one_location_ask_the_load_for_it_once():
    """60 offering rows on this plane name 38 distinct locations; an id asked twice is a fetch
    that grows with the page instead of with the places."""
    near = _address_fact(LOCATION, "Central")
    second = uuid4()
    rows = [_offering_row(), _offering_row(id=second, subject_id=str(second),
                                           slug="afternoon-tea-2")]
    cards, _bundle, backend = asyncio.run(_search(rows, [near],
                                                  subject_types=("offering",), query="下午茶"))
    assert len(cards) == 2, f"the fixture lane returned {len(cards)} of 2 offerings"
    asked = backend.fact_calls[0]
    assert asked.count(str(LOCATION)) == 1, (
        f"two cards on one location asked the load for it "
        f"{asked.count(str(LOCATION))} times: {asked}")
    assert all(_district_bullet(c) for c in cards), (
        "both cards print the same location's district and one of them cites nothing")


def test_an_offering_card_cites_its_own_merchants_nearest_location():
    """D449: one product, two candidate lanes. The merchant lane can cite a district while the
    offering card - a class, a treatment, an experience - prints one with nothing behind it."""
    cards, _bundle, _backend = asyncio.run(
        _search([_offering_row()], [_address_fact(LOCATION, "Central")],
                subject_types=("offering",), query="下午茶"))
    card = cards[0]
    assert "Central" in card.subtitle, f"the offering subtitle reads {card.subtitle!r}"
    bullet = _district_bullet(card)
    assert bullet, (
        f"an offering card printing a district raised {[r.label for r in card.ai_match.reasons]} "
        "and no district bullet - the fact load is merchant-or-offering keyed and the offering "
        "row's location was never asked for either")
    assert str(bullet[0].fact_id) in {str(f.fact_id) for f in card.facts}


# ------------------------------------------------------------------------- §18, kept strict
def test_a_row_that_prints_a_district_it_cannot_name_cites_nothing():
    """The card may not synthesise its way to a citation the plane never stated."""
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row(location_id=None)]))
    bullet = _district_bullet(cards[0])
    assert not bullet, (
        "a row with no location id raised a district bullet - the ladder's second rung is the "
        "row's own location and §2 refuses to invent one to cite a word")
    _kept, dropped = drop_ungrounded_reasons(cards[0])
    assert dropped == 0, (
        f"{dropped} bullet(s) shipped ungrounded - the builder must not raise what it cannot cite")


def test_a_merchant_keyed_address_fact_still_resolves():
    """The demo plane files its address facts under the merchant (`demo_data.py:151`) and its
    rows name no location, so that rung still has to answer for the district it prints."""
    fact_row = _address_fact(MERCHANT, "Central", subject_type="merchant")
    cards, _bundle, _backend = asyncio.run(
        _search([_merchant_row(location_id=None)], [fact_row]))
    bullet = _district_bullet(cards[0])
    assert bullet and str(bullet[0].fact_id) == str(fact_row["fact_id"]), (
        f"a merchant-keyed address fact stopped grounding the district it describes "
        f"(bullets: {[r.label for r in cards[0].ai_match.reasons]})")


# ------------------------------------------------------------------- what the load may not do
def test_a_location_fact_moves_no_ranking_number():
    """`Candidate.freshness` reads `facts_by_subject.get(subject_id)` - the merchant's OWN list
    (service.py:808). Widening the fetch must not silently widen that score."""
    with_fact, _b1, _r1 = asyncio.run(
        _search([_merchant_row()], [_address_fact(LOCATION, "Central")]))
    without, _b2, _r2 = asyncio.run(_search([_merchant_row(location_id=None)]))
    assert with_fact and without
    assert with_fact[0].score_breakdown == without[0].score_breakdown, (
        f"loading the location's address fact changed the card's score breakdown "
        f"({without[0].score_breakdown} -> {with_fact[0].score_breakdown}) - this unit cites "
        "districts, it does not re-rank them")


def test_the_loaded_fact_answers_the_clock_not_the_column():
    """All 684 rows say `stale = False` and were observed 36 days ago against a 30-day TTL.
    `facts_from_rows` re-evaluates (D589), so the fact that grounds the district arrives STALE -
    and still grounds it: §18 asks for a fact id, not a fresh one."""
    fact_row = _address_fact(LOCATION, "Central", stored_stale=False)
    ttl_days = FRESHNESS_TTL["address"] // 86400
    cards, _bundle, _backend = asyncio.run(_search([_merchant_row()], [fact_row],
                                                   now=SEED_CLOCK + timedelta(days=ttl_days + 6)))
    bullet = _district_bullet(cards[0])
    assert bullet, "the district bullet vanished under an old clock"
    fact = next(f for f in cards[0].facts
                if str(f.fact_id) == str(bullet[0].fact_id))
    assert fact.stale is True, (
        f"the fact row says stale={fact_row['stale']} and was observed {fact_row['observed_at']}, "
        f"{ttl_days} days is the address TTL - the loader is the lane that decides, and trusting "
        "the column is how a stale claim ships as a fresh one")
    assert bullet[0].value == "Central", (
        "the citation is still the merchant's own statement of where it is")


# ---------------------------------------------------------------------------- the live plane
@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set")
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    lat_min, lat_max, lng_min, lng_max = SQL.bbox(GEO[0], GEO[1], RADIUS)
    nearest = f"""
              SELECT lo.id, lo.district,
                     {SQL.haversine_expr('$1::float8', '$2::float8', 'lo.lat', 'lo.lng')}
                       AS meters
              FROM locations lo
              WHERE lo.merchant_id = m.id
                AND lo.lat BETWEEN $4::float8 AND $5::float8
                AND lo.lng BETWEEN $6::float8 AND $7::float8
              ORDER BY meters ASC NULLS LAST LIMIT 1"""

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out: dict[str, object] = {}
            out["keying"] = {
                r["subject_type"]: dict(n=r["n"], on_merchant=r["on_merchant"],
                                        on_location=r["on_location"])
                for r in await db.fetch(
                    "SELECT subject_type, count(*)::int n, "
                    "  count(*) FILTER (WHERE subject_id IN (SELECT id FROM merchants))::int "
                    "    on_merchant, "
                    "  count(*) FILTER (WHERE subject_id IN (SELECT id FROM locations))::int "
                    "    on_location "
                    "FROM facts WHERE attribute = 'address' GROUP BY 1")}
            rows = await db.fetch(f"""
                SELECT m.id AS merchant_id, l.id AS location_id, l.district, l.meters,
                       f.id AS fact_id, f.value->>'district' AS fact_district,
                       f.source, f.observed_at, f.stale
                FROM merchants m
                JOIN LATERAL ({nearest}) l ON TRUE
                LEFT JOIN facts f ON f.subject_id = l.id AND f.attribute = 'address'
                WHERE m.tenant_id = $3 AND m.status = 'published' AND l.meters <= $8::float8
                ORDER BY l.meters LIMIT 20""",
                GEO[0], GEO[1], TENANT, lat_min, lat_max, lng_min, lng_max, float(RADIUS))
            out["nearest_rows"] = [dict(r) for r in rows]
            out["spread"] = dict(await db.fetchrow("""
                SELECT count(*)::int merchants, max(n_locs)::int max_locs,
                       count(*) FILTER (WHERE n_districts > 1)::int district_spread
                FROM (SELECT merchant_id, count(*) n_locs,
                             count(DISTINCT district) n_districts
                      FROM locations GROUP BY 1) x"""))
            out["nearest_vs_primary"] = dict(await db.fetchrow(f"""
                SELECT count(*)::int multi,
                       count(*) FILTER (WHERE nearest_district IS DISTINCT FROM
                         primary_district)::int differs
                FROM (SELECT m.id,
                        (SELECT l.district FROM locations l
                         WHERE l.merchant_id = m.id AND l.is_primary LIMIT 1) primary_district,
                        nl.district nearest_district
                 FROM merchants m
                 LEFT JOIN LATERAL ({nearest}) nl ON TRUE
                 WHERE m.status = 'published' AND m.tenant_id = $3
                   AND (SELECT count(*) FROM locations l
                        WHERE l.merchant_id = m.id) > 1) x""",
                GEO[0], GEO[1], TENANT, lat_min, lat_max, lng_min, lng_max))
            backend = S.PostgresBackend(db)
            cards: dict[str, dict[str, list[Any]]] = {}
            for lane, types, text in (("merchant", ("merchant",), "咖啡店"),
                                      ("offering", ("offering",), "下午茶")):
                plan = S.SearchPlan(query_text=text, subject_types=types, geo=GEO,
                                    radius_m=RADIUS, limit=6)
                got, _resp, bundle, _scored = await S.search(backend=backend, plan=plan,
                                                             locale="zh-HK")
                cards[lane] = {"zh-HK": got, "bundle": list(bundle.facts)}
            out["cards"] = cards
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live_only
def test_the_plane_files_every_address_fact_under_a_location(plane):
    keying = plane["keying"]
    row = keying.get("location")
    assert row and row["n"] == 684, (
        f"this door measured 684 location-keyed `address` facts; the plane now files "
        f"{keying} - the premise below needs re-measuring")
    assert row["on_merchant"] == 0, (
        f"{row['on_merchant']} address facts are keyed to something that IS a merchant - the "
        "merchant-subject rung of the ladder is no longer a dead end and the load's shape "
        "should be re-read")
    assert keying.get("merchant") is None or keying["merchant"]["on_merchant"] == 0, (
        f"merchant-keyed address facts appeared ({keying.get('merchant')}) - the load would "
        "then reach them without the location id and the two rungs need an order decided on "
        "evidence")


@live_only
def test_the_location_a_live_geo_page_prints_has_its_own_address_fact(plane):
    rows = plane["nearest_rows"]
    assert len(rows) == 20, f"the geo page answered {len(rows)} rows, not 20"
    missing = [str(r["merchant_id"]) for r in rows if not r["fact_id"]]
    assert not missing, (
        f"{len(missing)} of {len(rows)} merchants have no address fact for the location their "
        "own row was built from - the fact is not sparse enough to be worth fetching only "
        "sometimes")
    differs = [str(r["merchant_id"]) for r in rows if r["fact_district"] != r["district"]]
    assert not differs, (
        f"{len(differs)} of {len(rows)} rows print {[(r['district'], r['fact_district']) for r in rows if r['fact_district'] != r['district']][:3]} - "
        "the citation would then disagree with the word on the card")


@live_only
def test_the_location_key_is_load_bearing_on_this_plane(plane):
    spread, np_ = plane["spread"], plane["nearest_vs_primary"]
    assert spread["merchants"] == 520 and spread["district_spread"] == 77, (
        f"the district spread moved ({spread}) - 77 of 520 merchants keep locations in more "
        "than one district is why the key is the location and not the merchant")
    assert np_["differs"] == 133 and np_["multi"] == 145, (
        f"nearest-vs-primary district disagreement is now {np_['differs']} of {np_['multi']} - "
        "a merchant-level lookup would cite a district the card is not printing for most "
        "multi-location merchants, so this door's choice of key has to stay measured")


@live_only
@pytest.mark.parametrize("lane", ("merchant", "offering"))
def test_a_live_geo_answer_cites_the_district_it_prints(plane, lane):
    cards = plane["cards"][lane]["zh-HK"]
    assert cards, "the live pipeline returned no card"
    printed = [c for c in cards if c.subtitle and "·" in str(c.subtitle)]
    assert len(printed) == len(cards), (
        f"{len(printed)} of {len(cards)} {lane} cards print a district; the door's claim is "
        "about the words the page shows")
    ungrounded = [c.title for c in cards if not _district_bullet(c)]
    assert not ungrounded, (
        f"{len(ungrounded)} of {len(cards)} live {lane} cards print a district with no "
        f"district bullet behind it: {ungrounded[:3]}")
    for c in cards:
        bullet = _district_bullet(c)[0]
        fact = next(f for f in c.facts if str(f.fact_id) == str(bullet.fact_id))
        assert fact.attribute == "address"
        assert fact.value["district"] == bullet.value, (
            f"{c.title} cites {fact.value!r} and prints {bullet.value!r}")
        assert bullet.value in c.subtitle, (
            f"{c.title}: bullet {bullet.value!r} is not the subtitle {c.subtitle!r}")
    _kept, dropped = drop_ungrounded_reasons(cards[0])
    assert dropped == 0, f"the §18 wire gate deleted {dropped} bullet(s) on a live card"


@live_only
def test_the_live_page_loads_nothing_the_rows_did_not_name(plane):
    cards = plane["cards"]["merchant"]["zh-HK"]
    ids = {str(c.id) for c in cards}
    loc_ids = {str(f.subject_id) for f in plane["cards"]["merchant"]["bundle"]
               if f.attribute == "address"}
    assert loc_ids, "no address fact reached the live bundle, so the citation above is a fixture"
    assert not (loc_ids & ids), (
        f"{sorted(loc_ids & ids)} - an address fact is keyed to a card subject, which the "
        "plane's own keying says does not happen; if it does, the two rungs need an order")
