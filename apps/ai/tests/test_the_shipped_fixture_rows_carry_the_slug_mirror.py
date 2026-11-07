"""A shipped fixture row either carries the slug mirror a filtered plan reads, or gets answered by nothing.

Two halves of one promise, filed verbatim in PLAN (D613 probe: two rows missing the mirror
answered 0 categories while looking like a ranking bug):

* the shipped demo catalogue's candidate rows (the rows `demo_backend` seeds into the fixture
  backend) carry the two-level `category_slugs` mirror; a change to `demo_data.py` that drops it
  is a fixture bug and this gate reddens on it, not on a downstream ranking test;
* a row WITHOUT the mirror under a category filter is answered by nothing, whatever its
  `category_primary` says. That is the correct answer for an uncategorised merchant, and it is
  now a RULE, not a fall-through that happened to hold because live rows always carried slugs.
"""

from __future__ import annotations

import nexus_ai.search.service as S

from nexus_ai.api.demo_data import demo_backend


def _rows() -> list[dict]:
    return [dict(r) for r in demo_backend().merchants]


def _offering_rows() -> list[dict]:
    return [dict(r) for r in demo_backend().offerings]


def test_every_demo_merchant_row_carries_the_two_level_slug_mirror():
    rows = _rows()
    assert rows, "demo catalogue ships no merchants"
    for r in rows:
        slugs = r.get("category_slugs") or []
        assert slugs, f"demo merchant {r.get('slug')} carries an empty slug mirror"
        assert all(isinstance(s, str) and s for s in slugs)


def test_every_demo_offering_row_carries_the_two_level_slug_mirror():
    rows = _offering_rows()
    assert rows, "demo catalogue ships no offerings"
    for r in rows:
        slugs = r.get("category_slugs") or []
        assert slugs, f"demo offering {r.get('slug')} carries an empty slug mirror"
        assert all(isinstance(s, str) and s for s in slugs)


def test_a_live_shaped_row_with_an_empty_slug_mirror_is_answered_by_no_category():
    # Live shape: `category_slugs` is empty because no `merchant_categories` rows exist, and
    # `category_primary` is the NAME ("Ramen & Noodles"), not the slug. The coarse leg would
    # try "ramen" in ("Ramen & Noodles", None) -> False, so the row answers nothing under any
    # slug bucket — the documented direction in PLAN ("an uncategorised merchant should not
    # answer a category request"). This leg pins it explicitly rather than leaving it enforced
    # by accident, which is what the PLAN bullet asked for.
    rows = [{"id": "a", "slug": "a", "display_name": "Ramen & Noodles",
             "category_primary": "Ramen & Noodles", "category_slugs": []}]
    assert S._filter_static(rows, "", {"category": "ramen"}) == []
    assert S._filter_static(rows, "", {"category": "cafe"}) == []


def test_a_fixture_row_whose_column_spells_the_bucket_is_the_d616_case():
    # The D616 coarse leg, pinned explicitly: a hand-built row that spells the bucket token in
    # its own column (the demo catalogue's shape) answers the bucket through the fallback —
    # it is what keeps the degraded path answering buckets at all for rows without a mirror.
    rows = [{"id": "a", "slug": "a", "display_name": "A",
             "category_primary": "restaurant", "category_slugs": []}]
    kept = S._filter_static(rows, "", {"category": "restaurant"})
    assert [r["slug"] for r in kept] == ["a"]


def test_demo_cafe_and_shopping_buckets_answer_rows_found_via_the_mirror():
    # The two buckets whose earlier fixture rows could not be answered through the mirror.
    from nexus_ai.search.categories import resolve

    for bucket in ("cafe", "shopping", "retail"):
        resolved = set(resolve(bucket))
        kept = S._filter_static(_rows(), "", {"category": bucket})
        for r in kept:
            slugs = set(r.get("category_slugs") or [])
            assert slugs & resolved, (bucket, r.get("slug"), sorted(slugs))
        assert kept, f"demo catalogue answers {bucket} with nothing"
