"""D611 - a stored number vouches only for a claim of its own kind.

`_feed` computed `kind = _attr_kind(attribute)` for every scalar it was handed, used it for one
membership test, then called `add_number(value, attribute, fact_id)` - the kind was built and
thrown away. `GroundSet.numbers`
is a list of values, so `find` compares a claim against every number on the page with the CLAIM's
tolerance and no reference to what the stored number is. A price, a review count, a day-of-week
index and a walk time become one pool.

Measured on the live plane (`tmp/d611_probe.py`, `tmp/d611_probe2.py`, 2026-10-29): a geo page
near Central at limit 6 carries **1,324 numbers**, of which **578 are the `weekday` integers 0..6
inside `opening_hours` facts** and 360 are `rating` values/counts/max_scores. Four assertions that
page reported as grounded, each vouched by a number of a kind it did not say:

    步行 700m   (distance) <- price.amount 681.71        (DISTANCE tolerance is +-60 m)
    評分 4.0   (rating)   <- opening_hours.weekday 4     (a day of the week)
    6 分鐘     (minutes)  <- opening_hours.weekday 6     (the same index)
    16 分鐘    (minutes)  <- rating.count 16            (a review count)

`verified` stays True for all four and `pipeline.py:255` ships the report.

**After, on those same two pages** (`tmp/d611_live.txt`): `步行 700m` is ungrounded, and so are
`評分 22`, `最平 HK$22` and the four D610 probes read as bare numbers (`22.4`, `22.05`, `114.05`,
`114.5`) - the `22` that used to catch them is filed as a COUNT now. `評分 4.0`, `6 分鐘` and
`16 分鐘` come back GROUNDED, on a real `rating.value` of 3.99 and on stored minutes: the rule
changes the witness, and where the page genuinely holds the kind the claim says the verdict stays.
That is the honest shape of this fix - an invented claim can still be right, but no longer by an
accident of the pool.

**The leaf and the attribute, because a stored value is nested.** A `rating` fact files
`{"count": 40, "value": 4.42, "max_score": 5, ...}` and a card's `distance` block files
`{"meters": 468, "travel_minutes": 6}`. Typing by the attribute alone puts the review count 40 in
the rating pool (vouch #4 above reads `rating.count`); typing by the leaf alone puts 4.42 in the
number pool, because the leaf `value` names no kind - and then the shipped bullet
`評分 4.4（40+ 條評價）` loses its witness. So the kind comes from the most specific key that DOES
name one: the leaf when it names a kind (`count` -> count, `travel_minutes` -> minutes, and
`distance.travel_minutes` reads MINUTES though its path reads DISTANCE), the attribute when the
leaf is generic. That rule ran over 15 pages, both lanes x 5 queries x 3 locales
(`tmp/d611_blast2.py`): **359 claims that ground today still ground, 4 stop** - and all 4 are
`找到 6 個`, the length of the page, which today is vouched by a `travel_minutes` 6 and by no
stored count at all. A page's own length is a fact the system holds, so `build_ground_set` now
files `len(records)` as a `result_count`.

Left open, measured, not fixed here: the day-of-week indices still sit in the NUMBER pool and
still vouch for a BARE number through its +-0.5 absolute floor; `max_score` sits in the RATING
pool, so an invented `評分 5.0` has a witness that is the scale; `COUNT_RE` needs the unit word
right after the digits, so the `40` in `（40+ 條評價）` is read as a rating (the literal `+` costs
the count its type) and is then rescued by `find`'s exact-text fallback with no fact id; and
`min_party_size`/`max_party_size` read as numbers, so a `8 位` claim cannot be vouched by a
capacity. One more the live run made visible rather than new: the pool is the WHOLE page, so the
`評分 4.0` above is vouched by one merchant's 3.99 while the sentence it sits in may be about
another - D611 fixed what KIND of number may vouch, not which card it belongs to. Pure and
DB-free; the live before/after is in `tmp/d611_probe.txt`, `tmp/d611_probe2.txt`,
`tmp/d611_blast2.txt` and `tmp/d611_live.txt`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import nexus_ai.trust.verification as V
from nexus_ai.contract import Fact
from nexus_ai.trust.facts import FactBundle

# Verbatim shapes off the live plane - a `price`, a `rating` and an `opening_hours` fact, and the
# card dump `pipeline.py:251` passes as `records` (tmp/d611_shape.py, 2026-10-29).
PRICE_VALUE = {"band": "$$$$", "model": "per_person", "amount": "681.71",
               "currency": "HKD", "data_origin": "demo"}
RATING_VALUE = {"count": 40, "value": 4.42, "method": "mean_of_published_reviews",
                "max_score": 5, "data_origin": "demo",
                "reviewed_through": "2026-07-29 07:48:29+08"}
OPENING_VALUE = {"zones": [{"opens": "12:00", "closes": "15:00", "weekday": 0},
                          {"opens": "18:00", "closes": "22:30", "weekday": 4},
                          {"opens": "11:30", "closes": "15:00", "weekday": 6}]}
ADDRESS_VALUE = {"lat": 22.291205, "lng": 114.172059,
                 "line1": "G/F, Unit 18, 123 Sze Avenue Workshop, Tsim Sha Tsui",
                 "line2": "尖沙咀海圍123號 中心18室", "district": "Tsim Sha Tsui",
                 "synthetic": True}


def _fact(attribute: str, value: object) -> Fact:
    return Fact(fact_id=uuid4(), subject_type="merchant", subject_id=uuid4(),
                attribute=attribute, value=value, source="merchant", confidence=0.9,
                observed_at=datetime(2026, 7, 29, tzinfo=timezone.utc))


def _bundle(*facts: Fact) -> FactBundle:
    return FactBundle(list(facts))


def _card(**over) -> dict:
    rec = {"id": "m1", "slug": "clay-ridge", "title": "藝記 Clay Ridge", "card_type": "merchant",
           "rating": {"value": 4.42, "count": 40,
                      "fact_id": "8d02107d-a13e-577f-b8b4-e1b5c423ab36"},
           "price": {"amount": "48.17", "currency": "HKD", "model": "per_person"},
           "distance": {"meters": 468, "text": "470m", "travel_minutes": 8,
                        "fact_id": "f3b0fc01-b5a7-599b-884d-41cfe27b3ca8"},
           "mtr_proximity": {"station": "Central", "walk_min": 14}}
    rec.update(over)
    return rec


def _gs(*facts: Fact, records: list[dict] | None = None, **kw) -> V.GroundSet:
    return V.build_ground_set(_bundle(*facts) if facts else None,
                              records=[_card()] if records is None else records, **kw)


def _kinds_for(gs: V.GroundSet, value: float) -> set[str]:
    """Every kind the pool files this value under."""
    return {n[1] for n in gs.numbers if n[0] == value}


def _rows(text: str, *facts: Fact, records: list[dict] | None = None):
    """(claim, grounded, grounded_value, fact_id) for every claim, through the shipped path."""
    gs = _gs(*facts, records=records)
    out = []
    for c in V.extract_claims(text):
        ok, fid, value = gs.find(c)
        out.append((c, ok, value, fid))
    return out


def _one(text: str, kind: str, *facts: Fact, records: list[dict] | None = None):
    hits = [r for r in _rows(text, *facts, records=records) if r[0].kind == kind]
    assert len(hits) == 1, (f"expected exactly one {kind} claim in {text!r}, got "
                            f"{[(r[0].text, r[0].kind, r[1]) for r in hits]}")
    claim, ok, value, _fid = hits[0]
    return claim, ok, value


class TestAWrongKindNumberIsNotAWitness:
    def test_a_price_does_not_vouch_for_a_distance(self):
        # live: 步行 700m was vouched by price.amount 681.71, |700-681.71| = 18.3 <= 60 m
        claim, ok, value = _one("步行 700m", V.DISTANCE_KIND, _fact("price", PRICE_VALUE))
        assert (claim.value, ok) == (700.0, False)

    def test_a_day_of_week_index_does_not_vouch_for_a_rating(self):
        # live: 評分 4.0 was vouched by opening_hours weekday 4, inside the 6% rating tolerance
        claim, ok, value = _one("評分 4.0", V.RATING_KIND, _fact("opening_hours", OPENING_VALUE),
                                _fact("rating", RATING_VALUE))
        assert (claim.value, ok) == (4.0, False)

    def test_a_review_count_does_not_vouch_for_a_walk_time(self):
        # live: 16 分鐘 was vouched by a `rating` fact's own count of 16 reviews
        claim, ok, value = _one("步行 16 分鐘", V.MINUTES_KIND,
                                _fact("rating", {**RATING_VALUE, "count": 16}))
        assert (claim.value, ok) == (16.0, False)

    def test_a_review_count_does_not_vouch_for_a_price(self):
        claim, ok, value = _one("最平 HK$40", V.MONEY_KIND, _fact("rating", RATING_VALUE))
        assert (claim.value, ok) == (40.0, False)

    def test_a_clock_minute_is_not_the_page_length(self):
        # live: `找到 6 個` on an offering page was vouched by one card's travel_minutes 6.
        # Nothing here stores a 6 - the six cards ARE the six, and only the page length knows that.
        cards = [_card(rating={"value": v, "count": n},
                       distance={"meters": m, "travel_minutes": t}) for v, n, m, t in (
            (4.42, 40, 468, 8), (3.9, 35, 512, 12), (4.1, 9, 681, 9),
            (4.2, 8, 930, 14), (4.3, 7, 1204, 15), (4.0, 10, 1455, 16))]
        claim, ok, value = _one("找到 6 個符合條件的選擇", V.COUNT_KIND, records=cards)
        assert (claim.value, ok, value) == (6.0, True, 6.0)

    def test_a_length_the_page_does_not_have_is_still_stripped(self):
        # today this grounds - on the travel_minutes 12 of one card, which is a walk time, not a
        # count of anything
        cards = [_card(distance={"meters": 468, "travel_minutes": 12}),
                 _card(distance={"meters": 512, "travel_minutes": 9})]
        claim, ok, value = _one("找到 12 個符合條件的選擇", V.COUNT_KIND, records=cards)
        assert (claim.value, ok) == (12.0, False)


class TestTheKeyThatNamesTheKind:
    def test_the_value_leaf_of_a_rating_is_a_rating(self):
        # the leaf `value` names no kind, so the attribute decides - else 評分 4.4 loses its witness
        assert _kinds_for(_gs(_fact("rating", RATING_VALUE)), 4.42) == {V.RATING_KIND}

    def test_the_count_leaf_of_a_rating_is_a_count(self):
        assert _kinds_for(_gs(_fact("rating", RATING_VALUE)), 40.0) == {V.COUNT_KIND}

    def test_walk_minutes_inside_a_distance_block_are_minutes(self):
        # the path `distance.travel_minutes` reads DISTANCE; the leaf reads MINUTES; the leaf wins
        assert _kinds_for(_gs(), 8.0) == {V.MINUTES_KIND}

    def test_the_meters_of_that_block_stay_a_distance(self):
        assert _kinds_for(_gs(), 468.0) == {V.DISTANCE_KIND}

    def test_a_walk_min_leaf_names_minutes_though_its_attribute_does_not(self):
        assert _kinds_for(_gs(), 14.0) == {V.MINUTES_KIND}

    def test_the_day_index_of_an_opening_hours_zone_is_a_plain_number(self):
        # left open on purpose: 0..6 stays in the NUMBER pool, where the +-0.5 floor still
        # vouches for a bare 4
        assert _kinds_for(_gs(_fact("opening_hours", OPENING_VALUE)), 4.0) == {V.NUMBER_KIND}

    def test_every_stored_number_carries_one_of_the_seven_kinds(self):
        gs = _gs(_fact("rating", RATING_VALUE), _fact("price", PRICE_VALUE),
                 _fact("opening_hours", OPENING_VALUE), _fact("address", ADDRESS_VALUE))
        assert {n[1] for n in gs.numbers} == {V.RATING_KIND, V.COUNT_KIND, V.MONEY_KIND,
                                              V.NUMBER_KIND, V.DISTANCE_KIND, V.MINUTES_KIND}

    def test_the_pool_holds_each_stored_number_once(self):
        # `_feed`'s second `if` re-added every number the kind test above had already accepted,
        # because `_attr_kind` returns one of the seven names for EVERY key: 1,744 entries on a
        # live `both` page, 938 of them distinct
        gs = _gs(_fact("rating", RATING_VALUE), _fact("price", PRICE_VALUE),
                 _fact("opening_hours", OPENING_VALUE), _fact("address", ADDRESS_VALUE))
        assert len(gs.numbers) == len({tuple(n) for n in gs.numbers})

    def test_a_request_number_is_a_number_and_not_a_price(self):
        gs = V.build_ground_set(None, extra_numbers=[320])
        assert (320.0, V.NUMBER_KIND, "request", None) in gs.numbers
        money = V.Claim(kind=V.MONEY_KIND, text="HK$320", start=0, end=5, value=320.0,
                        norm="320.0")
        assert gs.find(money)[0] is False
        bare = V.Claim(kind=V.NUMBER_KIND, text="320", start=0, end=3, value=320.0, norm="320")
        assert gs.find(bare)[0] is True

    def test_a_percent_has_no_stored_key_that_names_it(self):
        # `_attr_kind` returns money/rating/distance/minutes/count/number and never PERCENT, so
        # the percent pool is empty by construction; today a `92%` claim was vouched by ANY number
        # within +-0.5 - here the 92 of an untyped score (stored as an int, so its text "92" is
        # not the claim's "92.0" and the exact-text fallback cannot rescue it either). No shipped
        # copy states a percent (tmp/d611_blast2.txt: zero percent claims over 15 pages), so this
        # costs nothing and is left as the named consequence in PLAN.
        gs = _gs(_fact("ai_match", {"score": 92}), records=[])
        pct = V.Claim(kind=V.PERCENT_KIND, text="92%", start=0, end=3, value=92.0, norm="92.0")
        assert gs.find(pct)[0] is False


class TestTheCopyThatShipsStillShips:
    def test_every_bullet_a_live_card_carries_stays_grounded(self):
        # the shipped REASON_COPY for one merchant, verbatim, against the facts and the dump of
        # that card - this is the cost side: the rule must not silence an honest page
        copy = "\n".join(["找到 6 個符合條件的選擇", "距離你 470m", "評分 4.4（40+ 條評價）",
                         "港鐵 Central 站步行 14 分鐘", "位於 Tsim Sha Tsui"])
        r = V.verify_generated_text(copy, _bundle(_fact("rating", RATING_VALUE),
                                                 _fact("price", PRICE_VALUE),
                                                 _fact("opening_hours", OPENING_VALUE),
                                                 _fact("address", ADDRESS_VALUE)),
                                    records=[_card() for _ in range(6)], strip=False)
        assert [(c.text, c.kind, c.grounded_value) for c in r.claims if not c.grounded] == []
        assert r.verified is True

    def test_a_distance_still_needs_a_meters_number(self):
        claim, ok, value = _one("距離你 470m", V.DISTANCE_KIND)
        assert (claim.value, ok, value) == (470.0, True, 468.0)

    def test_a_walk_time_still_needs_a_minutes_number(self):
        claim, ok, value = _one("步行 14 分鐘", V.MINUTES_KIND)
        assert (claim.value, ok, value) == (14.0, True, 14.0)

    def test_a_price_still_needs_an_amount(self):
        claim, ok, value = _one("最化算 HK$48.17", V.MONEY_KIND, records=[_card()])
        assert (claim.value, ok) == (48.17, True)

    def test_the_coordinate_leaves_still_feed_no_number(self):
        # D610 holds
        gs = _gs(_fact("address", ADDRESS_VALUE), records=[])
        assert [n[0] for n in gs.numbers] == []
        assert "22.291205" in gs.strings
        assert "tsim sha tsui" in {s.lower() for s in gs.strings}

    def test_a_bare_number_still_grounds_on_a_stored_number_of_no_kind(self):
        claim, ok, value = _one("營業 4 小時", V.NUMBER_KIND, _fact("opening_hours", OPENING_VALUE))
        assert (claim.value, ok) == (4.0, True)
