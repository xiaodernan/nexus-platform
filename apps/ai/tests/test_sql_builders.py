"""Contract tests for the pure, DB-free surface of ``nexus_ai.search.sql`` NOT covered by the
sibling ``test_search_sql.py`` (which pins the category-taxonomy bridge).

This file pins: the ``Params`` no-inlining rule, the ``_tsconfig`` allow-list (SQL-injection /
typo guard), the geo math (``haversine_m`` / ``bbox``), ``vector_literal`` formatting, the
side-query empty-id guards, the chunk-query ``top_k`` clamp (§9 rerank budget), and the
open-now / time helpers. All builders are string-only — no DB connection is opened — so this is
fully DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
Where a naive premise was wrong (call signatures, the builders require ``embedding`` /
``merchant_id``), the premise was corrected, not the code.
"""

from __future__ import annotations

import nexus_ai.search.sql as S

TENANT = "tenant-pin-9f3a2b"
DISTINCT_TEXT = "sushi 壽司 distinct"


class TestParamsNoInlining:
    def test_add_returns_placeholder_and_records_value(self):
        p = S.Params()
        assert p.add(5) == "$1"
        assert p.add("x") == "$2"
        assert p.values == [5, "x"]

    def test_extend_returns_ordered_placeholders(self):
        p = S.Params()
        assert p.extend([1, 2, 3]) == ["$1", "$2", "$3"]
        assert p.values == [1, 2, 3]

    def test_nothing_is_inlined_in_merchant_query(self):
        q = S.build_merchant_query(tenant_id=TENANT, text=DISTINCT_TEXT, embedding=None)
        # user-supplied values are bound, never concatenated into SQL text
        assert TENANT not in q.sql
        assert DISTINCT_TEXT not in q.sql
        assert TENANT in q.params
        assert DISTINCT_TEXT in q.params


class TestTsConfigAllowlist:
    def test_known_configs_pass_through(self):
        assert S._tsconfig("simple") == "simple"
        assert S._tsconfig("english") == "english"

    def test_unknown_config_falls_back_to_simple(self):
        # never inline an un-allow-listed tsvector config name
        assert S._tsconfig("french") == "simple"
        assert S._tsconfig("") == "simple"

    def test_unknown_config_emitted_as_simple_in_sql(self):
        q = S.build_merchant_query(
            tenant_id=TENANT, text="x", embedding=None, ts_config="french"
        )
        assert q.ts_config == "simple"
        assert "to_tsquery('simple'" in q.sql


class TestMerchantQueryStructuralRules:
    def test_base_shape_and_tenant_bound(self):
        q = S.build_merchant_query(tenant_id=TENANT, text="x", embedding=None)
        assert "FROM merchants m" in q.sql
        assert "ORDER BY" in q.sql
        # leading placeholder is the text, second is the tenant (string form)
        assert q.params[1] == TENANT

    def test_empty_text_matches_everything(self):
        q = S.build_merchant_query(tenant_id=TENANT, text="", embedding=None)
        # no @@ text-match predicate when there is nothing to match against
        assert "@@" not in q.sql
        # Empty query must not claim a text match; ranking floor reads text_matched
        assert "false AS text_matched" in q.sql

    def test_geo_lane_adds_haversine_and_bbox(self):
        q = S.build_merchant_query(
            tenant_id=TENANT, text="x", embedding=None, geo=(22.3, 114.17), radius_m=1000
        )
        # the geo lane emits the spherical distance expression + bbox prefilter
        assert "acos(" in q.sql  # haversine / spherical law-of-cosines
        assert "BETWEEN" in q.sql and "loc.meters <=" in q.sql

    def test_avoid_filter_adds_negation(self):
        q = S.build_merchant_query(
            tenant_id=TENANT, text="x", embedding=None, filters={"avoid": ["spicy"]}
        )
        assert "AND NOT (" in q.sql

    def test_max_price_filter_present(self):
        q = S.build_merchant_query(
            tenant_id=TENANT, text="x", embedding=None, filters={"max_price": 200}
        )
        assert "avg_price_hkd <= " in q.sql
        assert 200.0 in q.params


class TestGeoHelpers:
    def test_haversine_identical_points_is_zero(self):
        assert S.haversine_m(22.3, 114.17, 22.3, 114.17) < 1e-6

    def test_haversine_is_symmetric(self):
        a = S.haversine_m(22.3, 114.17, 22.4, 114.2)
        b = S.haversine_m(22.4, 114.2, 22.3, 114.17)
        assert abs(a - b) < 1e-6

    def test_haversine_one_degree_latitude_approx(self):
        d = S.haversine_m(22.0, 114.0, 23.0, 114.0)
        assert 110000 < d < 113000

    def test_bbox_centered_and_wider_for_larger_radius(self):
        small = S.bbox(22.3, 114.17, 1000)
        large = S.bbox(22.3, 114.17, 2000)
        lat_min, lat_max, lng_min, lng_max = small
        assert lat_min < 22.3 < lat_max
        assert lng_min < 114.17 < lng_max
        # a larger radius yields a wider latitude window
        assert (large[1] - large[0]) > (small[1] - small[0])


class TestVectorLiteral:
    def test_six_decimal_formatting(self):
        assert S.vector_literal([0.1, 0.2, 0.3]) == "[0.100000,0.200000,0.300000]"

    def test_empty_embedding(self):
        assert S.vector_literal([]) == "[]"


class TestSideQueriesEmptyGuard:
    def test_empty_subject_ids_build_no_query(self):
        # prevents a `= ANY(ARRAY[])` SQL error / full-table scan
        assert S.facts_for([]) == ("", [])
        assert S.hours_for([]) == ("", [])
        assert S.reviews_for([]) == ("", [])
        assert S.entities_for(TENANT, []) == ("", [])

    def test_slots_empty_guard(self):
        from datetime import datetime

        assert S.slots_for([], datetime(2026, 1, 1), datetime(2026, 1, 2)) == ("", [])

    def test_nonempty_builds_bound_query(self):
        sql, params = S.facts_for(["id-1", "id-2"])
        assert "FROM facts" in sql
        assert ["id-1", "id-2"] in params


class TestChunkQuery:
    def test_top_k_clamped_to_40(self):
        # §9 rerank budget: top_k is capped at 40 regardless of request
        q = S.build_chunk_query(
            tenant_id=TENANT, merchant_id=None, text="x", embedding=[0.1, 0.2], top_k=999
        )
        assert 40 in q.params

    def test_top_k_respected_when_small(self):
        q = S.build_chunk_query(
            tenant_id=TENANT, merchant_id=None, text="x", embedding=None, top_k=8
        )
        assert 8 in q.params

    def test_vector_op_present_when_embedding(self):
        q = S.build_chunk_query(
            tenant_id=TENANT, merchant_id=None, text="x", embedding=[0.1, 0.2, 0.3]
        )
        assert "<=>" in q.sql


class TestOpenNowPredicate:
    def test_returns_weekday_and_hms(self):
        from datetime import datetime

        wd, hms = S.open_now_predicate_expr(datetime(2026, 1, 5, 13, 30, 0))  # naive -> HK
        assert isinstance(wd, int) and 0 <= wd <= 6
        assert hms == "13:30:00"

    def test_time_today(self):
        assert S.time_today(9, 30).hour == 9
        assert S.time_today(9, 30).minute == 30
