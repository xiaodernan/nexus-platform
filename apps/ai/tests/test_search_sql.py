"""The intent vocabulary must resolve through the `categories` taxonomy.

`merchants.category_primary` is a display label ("Ramen · Sha Tin") and the NLU answers with a
coarse bucket ("restaurant", "escape_room"). `=` between them matched no live row, so a
categorised search silently returned an empty page. These tests pin the resolver and prove the
candidate SQL walks `merchant_categories`/`categories` instead.
"""

from __future__ import annotations

from nexus_ai.search.categories import resolve
from nexus_ai.search.sql import build_merchant_query, build_offering_query

TENANT = "00000000-0000-0000-0000-000000000001"


def test_bucket_normalises_to_a_hyphenated_slug():
    assert "escape-room" in resolve("escape_room")
    # the raw bucket stays: the offline fixture catalogue stores it in `category`
    assert "escape_room" in resolve("escape_room")


def test_bucket_without_a_slug_counterpart_is_aliased():
    assert "gym-club" in resolve("gym")
    assert "yoga-pilates" in resolve("yoga")
    assert "bakery-dessert" in resolve("bakery")
    assert "shopping" in resolve("retail")
    assert "experience" in resolve("attraction")


def test_unknown_bucket_resolves_to_itself_and_never_nothing():
    assert resolve("sushi_burrito") == ["sushi_burrito", "sushi-burrito"]
    assert resolve("") == []
    assert resolve(None) == []


def test_resolve_is_order_stable_and_deduped():
    first, second = resolve("restaurant"), resolve("restaurant")
    assert first == second and len(first) == len(set(first))


def test_merchant_category_filter_uses_the_taxonomy_tables():
    q = build_merchant_query(tenant_id=TENANT, text="ramen", embedding=None,
                             filters={"category": "restaurant"})
    assert "merchant_categories mc" in q.sql
    assert "categories pc" in q.sql          # the leaf-under-root walk
    assert "m.category_primary =" not in q.sql
    assert ["restaurant"] in [v for v in q.params if isinstance(v, list)]


def test_offering_category_filter_matches_the_merchant_lane():
    q = build_offering_query(tenant_id=TENANT, text="ramen",
                             filters={"category": "escape_room"})
    assert "merchant_categories mc" in q.sql
    assert "escape-room" in next(v for v in q.params if isinstance(v, list))


def test_no_category_means_no_taxonomy_join():
    q = build_merchant_query(tenant_id=TENANT, text="ramen", embedding=None)
    assert "merchant_categories" not in q.sql
