"""D401 - the comparison grid carries a distance and a district, and every cell is checkable.

§37: "three merchants from real rows only". The e2e spec asserts the compare table shows
Price, Rating and Distance. The live grid had neither a distance row nor a district row
(the district cells were always empty, because `entities_for` selects no district
column), and the category and district cells carried no fact id, so the UI rendered them
as the unverified marker - two rows of "unverified" in the product's comparison table.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

import nexus_ai.api.routes_discover as RD
from nexus_ai.contract import CompareRequest
from nexus_ai.search import sql as SQL
from nexus_ai.trust.facts import FactBundle


# --------------------------------------------------------------------------- the request
def test_the_compare_request_accepts_a_point_to_measure_from():
    body = CompareRequest(subject_ids=[uuid4(), uuid4()],
                          geo={"lat": 22.3809, "lng": 114.1861})
    assert body.geo is not None
    assert body.geo.lat == 22.3809


def test_the_compare_request_does_not_require_a_point():
    body = CompareRequest(subject_ids=[uuid4(), uuid4()])
    assert body.geo is None


def test_the_compare_request_still_forbids_an_unknown_field():
    with pytest.raises(ValidationError):
        CompareRequest(subject_ids=[uuid4(), uuid4()], merchant_ids=[uuid4()])


# --------------------------------------------------------------------------- the query
def test_the_geo_query_reads_the_distance_and_the_district():
    sql, params = SQL.compare_geo("tenant-1", ["m1", "m2"], 22.3809, 114.1861)
    assert "meters" in sql
    assert "district" in sql
    assert "locations" in sql
    assert "is_primary" in sql
    assert len(params) == 4  # tenant, ids, lat, lng


def test_the_geo_query_is_empty_without_merchants():
    sql, params = SQL.compare_geo("tenant-1", [], 22.3809, 114.1861)
    assert sql == ""
    assert params == []


# --------------------------------------------------------------------------- the grid
def _entity_row(sid: str, mid: str) -> dict:
    """A merchant row as `entities_for` returns it: uuid subject and merchant ids."""
    return {"subject_id": sid, "subject_type": "merchant", "merchant_id": mid,
            "slug": "s", "name": "N", "name_zh": "N", "category": "Cantonese",
            "avg_price_hkd": 100.0, "rating_agg": 4.5, "review_count": 10,
            "status": "published"}


M1 = str(uuid4())
M2 = str(uuid4())


def test_the_grid_keeps_the_distance_row_when_a_point_is_given():
    bundle = FactBundle()
    rows = RD._grid(
        [_entity_row(M1, M1), _entity_row(M2, M2)],
        bundle,
        {M1: [], M2: []},
        now=datetime.now(timezone.utc), locale="zh-HK",
        distances={M1: 410.0, M2: 1400.0},
    )
    attributes = [r["attribute"] for r in rows]
    assert "distance" in attributes
    distance = next(r for r in rows if r["attribute"] == "distance")
    assert distance["cards"][0]["value"]
    assert distance["cards"][0]["fact_id"], "a distance cell without a fact id renders as unverified"
    assert distance["cards"][1]["fact_id"]


def test_the_grid_has_no_distance_row_without_a_point():
    bundle = FactBundle()
    rows = RD._grid(
        [_entity_row(M1, M1)],
        bundle,
        {M1: []},
        now=datetime.now(timezone.utc), locale="zh-HK",
    )
    assert "distance" not in [r["attribute"] for r in rows]


def test_the_grid_keeps_the_district_row_when_the_location_knows_it():
    bundle = FactBundle()
    rows = RD._grid(
        [_entity_row(M1, M1), _entity_row(M2, M2)],
        bundle,
        {M1: [], M2: []},
        now=datetime.now(timezone.utc), locale="zh-HK",
        districts={M1: "Sha Tin", M2: "Tai Wai"},
    )
    district = next(r for r in rows if r["attribute"] == "district")
    assert district["cards"][0]["value"] == "Sha Tin"
    assert district["cards"][0]["fact_id"], "a district cell without a fact id renders as unverified"


def test_the_category_cell_is_fact_backed():
    bundle = FactBundle()
    rows = RD._grid(
        [_entity_row(M1, M1)],
        bundle,
        {M1: []},
        now=datetime.now(timezone.utc), locale="zh-HK",
    )
    category = next(r for r in rows if r["attribute"] == "category")
    assert category["cards"][0]["value"] == "Cantonese"
    assert category["cards"][0]["fact_id"], "a category cell without a fact id renders as unverified"
