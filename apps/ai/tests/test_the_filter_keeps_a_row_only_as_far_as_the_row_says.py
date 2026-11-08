"""D764 - the static lane's geo answer honours the row's own computed distance.

`_filter_static` drops a row that states no `location_points` when a geo request is placed,
which is the live lane's `l.id IS NOT NULL` rule. But `build_merchant_query`'s output under a
geo request carries `meters` as a COLUMNS value (haversine over the row's picked location,
NULL elsewhere), and `ORDER BY meters ASC NULLS LAST LIMIT` leaves only rows whose location
is inside the bbox in the page at all. The fixture rows the D609 gate served hold
`meters: 468.0` and no `location_points` — and they were dropped at the static geo cut, so
every D609 gate answered "the fixture lane answered nothing".

The rule: a row whose computed distance IS NOT NULL is a row the live lane kept at that
distance; the request still has to fall inside the radius.
"""

from __future__ import annotations

import pytest

import nexus_ai.search.service as S


def _row(**over):
    base = {"id": "m1", "subject_id": "m1", "subject_type": "merchant",
            "display_name": "Teahouse", "display_name_zh": "茶樓",
            "category_primary": "cafe", "avg_price_hkd": 120.0,
            "rating_agg": 4.2, "review_count": 30,
            "attributes": {}, "tags": ["茶"], "kw_score": 0.9, "text_matched": True}
    base.update(over)
    return base


GEO = (22.282, 114.156)


def test_a_row_stating_its_own_computed_distance_is_kept_at_that_distance():
    rows = [_row(meters=468.0, location_points=None)]
    kept = S._filter_static(rows, "", {"open_now": False}, geo=GEO, radius_m=3000)
    assert kept, "a row the live lane would answer at ~468 m was dropped for lack of points"
    assert kept[0]["meters"] == 468.0


def test_the_request_radius_still_cuts_a_far_row():
    rows = [_row(meters=5_000.0, location_points=None)]
    assert S._filter_static(rows, "", {}, geo=GEO, radius_m=100) == [], (
        "a row whose own distance exceeds the request radius was kept")


def test_a_row_that_states_neither_a_point_nor_a_distance_is_dropped():
    rows = [_row()]
    assert S._filter_static(rows, "", {}, geo=GEO, radius_m=3000) == [], (
        "a row stating no location of any kind was kept - the live cut requires one")


def test_a_row_whose_points_are_farther_than_the_radius_is_dropped():
    rows = [_row(meters=None,
                 location_points=[{"lat": 22.34, "lng": 114.35}])]
    assert S._filter_static(rows, "", {}, geo=GEO, radius_m=100) == [], (
        "a row whose own point exceeds the request radius was kept")


def test_a_row_whose_points_place_it_within_the_radius_is_kept():
    rows = [_row(meters=None,
                 location_points=[{"lat": 22.282, "lng": 114.157}])]
    kept = S._filter_static(rows, "", {}, geo=GEO, radius_m=3000)
    assert kept and kept[0]["meters"] and kept[0]["meters"] > 0
