"""Contract tests for the offline demo catalogue (``api/demo_data``, spec §109/§155).

The demo catalogue powers the DB-free HTTP layer, so its honesty rules are a contract:
every row carries ``data_origin="demo"``, ids are deterministic (uuid5), every offering
references a real merchant and inherits its category/district, and every rendered number
(price/rating) ships with a backing ``facts`` row — nothing is invented at request time.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import nexus_ai.api.demo_data as DD

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


class TestDeterministicIds:
    def test_same_input_same_id(self):
        assert DD._id("merchant", "demo-x") == DD._id("merchant", "demo-x")

    def test_kind_changes_id(self):
        assert DD._id("merchant", "x") != DD._id("offering", "x")


class TestMerchantRows:
    def test_count_and_origin(self):
        rows = DD._merchant_rows()
        assert len(rows) == 6
        assert all(r["data_origin"] == "demo" for r in rows)

    def test_subject_and_merchant_ids_are_the_row_id(self):
        for r in DD._merchant_rows():
            assert r["subject_id"] == r["merchant_id"] == r["id"]

    def test_ai_agent_enabled_only_for_one(self):
        assert [r["slug"] for r in DD._merchant_rows() if r["ai_agent_enabled"]] == [
            "demo-lan-kwai-fong"
        ]

    def test_attributes_empty(self):
        assert all(r["attributes"] == {} for r in DD._merchant_rows())

    def test_slugs_and_ids_are_unique(self):
        rows = DD._merchant_rows()
        assert len({r["slug"] for r in rows}) == len(rows)
        assert len({r["id"] for r in rows}) == len(rows)


class TestOfferingRows:
    def test_count_and_origin(self):
        rows = DD._offering_rows()
        assert len(rows) == 2
        assert all(r["data_origin"] == "demo" for r in rows)

    def test_every_offering_references_a_real_merchant(self):
        slugs = {m["slug"] for m in DD._MERCHANTS}
        assert all(r["merchant_slug"] in slugs for r in DD._offering_rows())

    def test_merchant_id_matches_parent(self):
        for r in DD._offering_rows():
            assert r["merchant_id"] == DD._id("merchant", r["merchant_slug"])

    def test_category_and_district_inherited(self):
        for r in DD._offering_rows():
            parent = next(m for m in DD._MERCHANTS if m["slug"] == r["merchant_slug"])
            assert r["category"] == parent["category_primary"]
            assert r["district"] == parent["district"]


class TestFactRows:
    def test_count_and_freshness(self):
        facts = DD._fact_rows(NOW)
        assert len(facts) == 19
        assert all(f["stale"] is False for f in facts)
        assert all(f["observed_at"] == NOW - timedelta(hours=2) for f in facts)

    def test_every_offering_has_a_price_fact(self):
        facts = DD._fact_rows(NOW)
        offering_prices = [f for f in facts
                           if f["subject_type"] == "offering" and f["attribute"] == "price"]
        assert len(offering_prices) == len(DD._OFFERINGS) == 2

    def test_merchant_price_facts_only_where_price_exists(self):
        facts = DD._fact_rows(NOW)
        merchant_prices = [f for f in facts
                           if f["subject_type"] == "merchant" and f["attribute"] == "price"]
        with_price = [m for m in DD._MERCHANTS if m["avg_price_hkd"] is not None]
        assert len(merchant_prices) == len(with_price) == 5

    def test_every_merchant_has_address_and_rating(self):
        facts = DD._fact_rows(NOW)
        attrs = [f["attribute"] for f in facts if f["subject_type"] == "merchant"]
        assert attrs.count("address") == 6
        assert attrs.count("rating") == 6

    def test_fact_ids_are_deterministic(self):
        a = DD._fact_rows(NOW)
        b = DD._fact_rows(NOW)
        assert [f["fact_id"] for f in a] == [f["fact_id"] for f in b]


class TestHoursRows:
    def test_count_and_weekdays(self):
        hours = DD._hours_rows()
        assert len(hours) == 35  # first 5 merchants x 7 weekdays
        assert sorted({h["weekday"] for h in hours}) == [0, 1, 2, 3, 4, 5, 6]

    def test_opens_at_1130(self):
        assert all(h["opens_at"].strftime("%H:%M") == "11:30" for h in DD._hours_rows())

    def test_restaurants_close_late_cafe_closes_early(self):
        hours = DD._hours_rows()
        restaurant_ids = {DD._id("merchant", m["slug"]) for m in DD._MERCHANTS[:5]
                          if m["category_primary"] == "restaurant"}
        cafe_id = DD._id("merchant", "demo-bamboo-tea-house")
        assert all(h["closes_at"].strftime("%H:%M") == "23:00"
                   for h in hours if h["merchant_id"] in restaurant_ids)
        assert all(h["closes_at"].strftime("%H:%M") == "19:00"
                   for h in hours if h["merchant_id"] == cafe_id)


class TestDemoBackend:
    def test_counts(self):
        b = DD.demo_backend(now=NOW)
        assert len(b.merchants) == 6
        assert len(b.offerings) == 2
        assert len(b._facts) == 19
        assert len(b._hours) == 35

    def test_demo_is_active(self):
        assert DD.demo_is_active(DD.demo_backend(now=NOW)) is True
        assert DD.demo_is_active(object()) is False
