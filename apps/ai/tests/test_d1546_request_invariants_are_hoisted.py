"""D1546 - the static filter lane builds each request-constant filter ONCE, not per row.

`_filter_static` mirrors the live SQL WHERE clauses in Python for the degraded/demo plane.
Three of those filters are read from the REQUEST and never change across rows, yet each was
re-materialised inside the `for r in rows` loop: the `exclude` id set (line 420), the `tags`
intersection operand (line 417) and the `attributes` item view (line 428). This is the same
lane D913 already hoisted the avoid-index out of (O(rows x offerings) -> O(rows)); these three
were left behind.

The door counts how many times the request object is consumed by passing a counting iterable /
dict, and checks the kept rows are unchanged. Shipped: the count tracks the row count. Fixed:
each is consumed exactly once per request.
"""
from __future__ import annotations

from nexus_ai.search import service as S


class CountingList(list):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.iterations = 0

    def __iter__(self):
        self.iterations += 1
        return super().__iter__()


class CountingDict(dict):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.item_calls = 0

    def items(self):
        self.item_calls += 1
        return super().items()


def _rows(n):
    return [{"subject_id": f"s{i}", "id": f"s{i}", "display_name": f"M{i}",
             "tags": ["thai"] if i % 2 == 0 else ["japanese"],
             "attributes": {"quiet_ambience": True} if i % 3 == 0 else {}}
            for i in range(n)]


class TestRequestInvariantsAreHoisted:
    def test_r1_exclude_set_built_once_not_per_row(self):
        n = 8
        excl = CountingList(["s0", "s1", "s2"])
        kept = {r["subject_id"] for r in S._filter_static(_rows(n), "", {"exclude": excl})}
        assert kept == {"s3", "s4", "s5", "s6", "s7"}   # verdict unchanged
        assert excl.iterations == 1                     # one pass, not one per row

    def test_r2_tags_operand_built_once_not_per_row(self):
        n = 8
        tags = CountingList(["thai"])
        kept = {r["subject_id"] for r in S._filter_static(_rows(n), "", {"tags": tags})}
        assert kept == {"s0", "s2", "s4", "s6"}          # only thai rows
        assert tags.iterations == 1

    def test_r3_attributes_view_built_once_not_per_row(self):
        n = 9
        attrs = CountingDict({"quiet_ambience": True})
        kept = {r["subject_id"] for r in S._filter_static(_rows(n), "", {"attributes": attrs})}
        assert kept == {"s0", "s3", "s6"}                # rows whose attrs match
        assert attrs.item_calls == 1

    def test_r4_empty_request_filters_cost_no_per_row_pass(self):
        # Absent / empty filters must short-circuit: the request objects are never consumed.
        n = 8
        excl = CountingList()               # empty -> falsy guard, must not be iterated
        kept = {r["subject_id"] for r in S._filter_static(_rows(n), "", {"exclude": excl})}
        assert kept == {f"s{i}" for i in range(n)}
        assert excl.iterations == 0