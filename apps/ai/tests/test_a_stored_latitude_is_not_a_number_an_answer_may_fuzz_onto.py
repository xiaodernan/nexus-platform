"""D610 - a stored latitude is not a number an answer may fuzz onto.

`build_ground_set` feeds EVERY scalar of EVERY bundle fact into `GroundSet.numbers`, and
`GroundSet.find` matches a numeric claim against that list by `diff <= max(abs_tol,
rel*abs(value))`. A claim the extraction can type gets a tolerance written for its kind - two
per cent for money, six hundredths for a rating - but an untyped bare number falls through to
`TOLERANCE[NUMBER_KIND] = (0.01, 0.5)`, an ABSOLUTE half-unit floor. Half a degree of latitude
is ~55 km, larger than the whole territory this product answers in. D609 is what made this
bite: the fact load now fetches the `address` fact, and every `address` value in this plane
carries a `lat` and an `lng`.

Measured on the live plane (`tmp/d610_probe.py`, 2026-10-29), a geo page near Central, limit 6:

    [merchant] 6 cards | ground set 1444 numbers / 791 strings | coordinate-derived 120
    [offering] 6 cards | ground set  520 numbers / 465 strings | coordinate-derived  88
    lat band 22.2748..22.2973   ->  fuzzy window 21.7748..22.7973
    lng band 114.1551..114.1850 ->  fuzzy window 113.6551..114.6850

Numbers the gate read as grounded, each citing a real `address` fact's `fact_id`, none of them a
value stored on that page (1 degree of latitude ~111 km, of longitude here ~103 km):

    claim 22.4      backs onto 22.297322   (11 km away)
    claim 22.29     backs onto 22.290682   (the truncation of a real latitude)
    claim 114.05    backs onto 114.15512   (11 km)
    claim 114.5     backs onto 114.184999  (32 km)
    claim 22.385428 backs onto 22.297322   (9.8 km from the position actually stored)

A sixth probe, `22.05`, grounded onto a plain stored `22.0` - the `count` inside a merchant
`rating` fact - which is the half-unit floor D610 did not touch and PLAN now carries on its own.

So `verified=False` is a report a fabricated coordinate never triggers, and `as_dict()` ships
it to the client through `pipeline.py:255` as though it had checked.

**Which keys, across the whole corpus.** `tmp/d610_key_probe.py` walked all 5,692 `facts` rows
and every flattened card dump: the only coordinate-shaped leaf keys anywhere are `lat` and
`lng`, both inside `address` (684 of each), plus the same pair re-appearing in the record path
as `facts.value.lat` / `facts.value.lng`, 6 of each per page. 108 + 12 = 120 on the merchant
page, 76 + 12 = 88 on the offering page - the whole reservoir, accounted for. The closed set is
therefore named by leaf key and matched on the LAST dotted segment only: `plate` and
`translate` contain `lat` and are quantities like any other.

**The cost, disclosed.** A coordinate stops grounding its own truncation. `BARE_NUMBER_RE`
captures `(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?)`, so copy echoing `22.297322` yields a claim of
`22.29`, which matched the stored value through the tolerance and now does not; the string
fallback at `find()`'s tail needs the exact text, which extraction cannot produce. No shipped
surface states a coordinate - the mock summary (`models/mock.py:_summary`) prints titles, prices,
distances and ratings, and the `REASON_COPY` sentences print a district word, never a position -
and measured live (`tmp/d610_live.py`) the summary the shipped mock makes for both pages asserts
two claims apiece, a count and a distance, and verifies clean. So this removes reservoir, not
copy. §4 asks a claim to resolve to a fact, not to a rounding of one. Pure and DB-free; the
before/after on the plane is in `tmp/d610_live.py`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import nexus_ai.trust.verification as V
from nexus_ai.contract import Fact
from nexus_ai.trust.facts import FactBundle

# a verbatim `address` value from the live plane (tmp/d609_address_shape.txt)
ADDRESS_VALUE = {"lat": 22.297322, "lng": 114.184999,
                 "line1": "2/F, Unit 10, 2 Sing Street Plaza, Sha Tin",
                 "line2": "沙田成街2號 中心10室", "district": "Sha Tin", "synthetic": True}


def _fact(*, attribute: str, value, fact_id=None) -> Fact:
    return Fact(fact_id=fact_id or uuid4(), subject_type="merchant", subject_id=uuid4(),
                attribute=attribute, value=value, source="merchant", confidence=0.9,
                observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc))


def _number(value: float, norm: str | None = None, *, kind: str = V.NUMBER_KIND) -> V.Claim:
    return V.Claim(kind=kind, text=str(value), start=0, end=0, value=value,
                   norm=norm if norm is not None else str(value))


def _address_bundle(*extra: Fact) -> FactBundle:
    return FactBundle([_fact(attribute="address", value=ADDRESS_VALUE), *extra])


class TestACoordinateIsNotAQuantity:
    def test_a_stored_latitude_is_not_added_as_a_number(self):
        gs = V.build_ground_set(_address_bundle())
        values = [n[0] for n in gs.numbers]
        assert 22.297322 not in values
        assert 114.184999 not in values

    def test_an_invented_number_in_the_coordinate_band_is_not_grounded(self):
        gs = V.build_ground_set(_address_bundle())
        for claim_value in (22.4, 22.29, 22.05, 114.05, 114.5):
            assert gs.find(_number(claim_value))[0] is False, (
                f"{claim_value} still fuzzes onto a stored coordinate - the §4 gate vouches "
                f"for a position no fact states")

    def test_the_address_fact_contributes_no_numbers_at_all(self):
        assert V.build_ground_set(_address_bundle()).numbers == []

    def test_the_record_path_is_closed_too(self):
        rec = {"display_name": "Café", "facts": [{"value": dict(ADDRESS_VALUE)}]}
        gs = V.build_ground_set(None, records=[rec])
        # the one number this page contributes is its own length (D611) - no coordinate is in it
        assert gs.numbers == [(1.0, V.COUNT_KIND, "result_count", None)]
        assert gs.find(_number(22.4))[0] is False

    def test_the_full_spellings_are_closed(self):
        bundle = FactBundle([_fact(attribute="geo",
                                   value={"latitude": 22.3, "longitude": 114.17})])
        gs = V.build_ground_set(bundle)
        assert [n[0] for n in gs.numbers] == []
        assert gs.find(_number(22.4))[0] is False

    def test_a_coordinate_inside_a_list_is_closed(self):
        bundle = FactBundle([_fact(attribute="footprint",
                                   value={"points": [{"lat": 22.28}, {"lat": 22.29}]})])
        assert V.build_ground_set(bundle).numbers == []

    def test_the_leaf_key_is_matched_exactly_not_as_a_substring(self):
        # `plate` and `translate` contain "lat" and are quantities like any other; only the
        # last segment of the key decides.
        bundle = FactBundle([_fact(attribute="menu", value={"plate": 22.4,
                                                            "translate": 114.5})])
        gs = V.build_ground_set(bundle)
        assert sorted(n[0] for n in gs.numbers) == [22.4, 114.5]
        assert gs.find(_number(22.4))[0] is True

    def test_a_number_that_merely_looks_like_a_coordinate_survives(self):
        # the gate is keyed, not value-shaped: 22.0 under `count` is a count and stays in the
        # pool. D611 is the rule that it vouches for a COUNT claim of 22 and not for a bare 22.05.
        bundle = FactBundle([_fact(attribute="stats", value={"lat": 22.3, "count": 22.0})])
        gs = V.build_ground_set(bundle)
        assert [n[0] for n in gs.numbers] == [22.0]
        assert gs.find(_number(22, "22", kind=V.COUNT_KIND))[0] is True
        assert gs.find(_number(22.05))[0] is False

    def test_key_case_and_padding_do_not_smuggle_one_back(self):
        bundle = FactBundle([_fact(attribute="address", value={"Lat": 22.4, " LNG": 114.5})])
        assert V.build_ground_set(bundle).numbers == []


class TestTheAddressFactStillMeansSomething:
    def test_its_words_are_still_in_the_ground_set(self):
        gs = V.build_ground_set(_address_bundle())
        assert "sha tin" in gs.strings
        assert "2/f, unit 10, 2 sing street plaza, sha tin" in gs.strings
        assert "沙田成街2號 中心10室" in gs.strings

    def test_an_exact_echo_of_a_coordinate_is_still_a_stored_string(self):
        gs = V.build_ground_set(_address_bundle())
        assert "22.297322" in gs.strings
        assert "114.184999" in gs.strings


class TestNothingElseMoves:
    def test_a_price_still_grounds_its_own_number(self):
        # "its own" is now literal: the stored 188.44 vouches for a MONEY claim of 188, which is
        # what the copy that ships says (row below), and for nothing else.
        price = _fact(attribute="avg_price_hkd", value=188.44)
        gs = V.build_ground_set(_address_bundle(price))
        grounded, fact_id, value = gs.find(_number(188.0, "188", kind=V.MONEY_KIND))
        assert grounded is True
        assert fact_id == price.fact_id
        assert value == 188.44

    def test_money_copy_over_a_coordinate_bundle_still_passes(self):
        bundle = _address_bundle(_fact(attribute="avg_price_hkd", value=188.44))
        report = V.verify_generated_text("收費 HK$188。", bundle=bundle)
        assert report.verified is True
        assert report.hallucination_count == 0

    def test_a_rating_still_grounds(self):
        bundle = _address_bundle(_fact(attribute="rating", value=4.41))
        assert V.verify_generated_text("評分 4.4", bundle=bundle).verified is True

    def test_a_distance_still_grounds(self):
        bundle = _address_bundle(_fact(attribute="distance_m", value=683.0))
        assert V.verify_generated_text("700m", bundle=bundle).verified is True

    def test_a_request_number_still_grounds(self):
        gs = V.build_ground_set(_address_bundle(), extra_numbers=[320])
        assert gs.find(_number(320))[0] is True


class TestVerifiedText:
    def test_a_fabricated_coordinate_is_stripped_and_a_real_price_kept(self):
        bundle = _address_bundle(_fact(attribute="avg_price_hkd", value=188.44))
        report = V.verify_generated_text("22.4 度附近，HK$188。", bundle=bundle)
        assert report.hallucination_count == 1
        assert report.verified is False
        assert "22.4" not in report.text
        assert "188" in report.text

    def test_the_truncated_echo_of_a_real_coordinate_is_stripped(self):
        # the disclosed cost, pinned: 22.29 IS a truncation of the stored 22.297322, and the
        # tolerance used to be wide enough to call that grounded. A claim must resolve to a
        # fact, not to a rounding of one.
        bundle = _address_bundle()
        report = V.verify_generated_text("22.29 度", bundle=bundle)
        assert report.hallucination_count == 1
        assert report.stripped[0].value == 22.29
        assert "22.29" not in report.text

    def test_shipped_shaped_copy_with_no_coordinate_is_unmoved(self):
        # the four assertions the mock summary of a real geo page actually makes
        bundle = _address_bundle(_fact(attribute="avg_price_hkd", value=188.44),
                                 _fact(attribute="rating", value=4.41),
                                 _fact(attribute="distance_m", value=683.0),
                                 _fact(attribute="review_count", value=6.0))
        report = V.verify_generated_text("找到 6 個符合條件的選擇。HK$188 評分 4.4 700m",
                                         bundle=bundle)
        assert report.verified is True
        assert report.claim_count == 4
