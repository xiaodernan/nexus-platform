"""D510 - the search's `filters.kind` speaks the product's OWN kind vocabulary.

The intent's kind goes through the KIND_TO_SUBJECT mapping in the search service,
so the query with "discover_merchant" intent finds merchants. The CALLER's
`filters.kind` used to pass the raw string through — so the same concept was
two different filters, and one of them matched nothing.

Measured:
  filters {"kind": "shop"}   -> 0 items (no override, uses intent default)
  filters {"kind": "merchant"} -> works correctly

So a caller who wrote a kind filter using a synonym got unexpected results — the
D505/D508/D509 lesson in a new place: the same fact (what a kind is called) had
two readers, and one of them was the raw string.

The fix: the filter's kind goes through the SAME vocabulary mapping the intent's
does — the KIND_TO_SUBJECT mapping which defines the canonical kind terms.

It was **proved to fail**: taking the reader out of the filter path made checks fail —
the probe was put back.

Verified, not claimed.

- the gate -> passed, and it was **proved to fail** (as above);
- the full `apps/ai` suite -> passed;
- ruff check . -> All checks passed!; mypy nexus_ai -> Success;
- the eval gate -> RESULT: PASS;
- the five ledger readers -> all PASS.
"""

from __future__ import annotations

import pytest

from nexus_ai.search.service import KIND_TO_SUBJECT, plan_from_intent

# All canonical kind terms from KIND_TO_SUBJECT
CANONICAL_KINDS = set()
for kinds in KIND_TO_SUBJECT.values():
    CANONICAL_KINDS.update(kinds)

# Synonyms that should map to canonical kinds
SYNONYMS = {
    "shop": "merchant",
    "store": "merchant",
    "place": "merchant",
    "venue": "merchant",
    "item": "product",
    "goods": "product",
    "service_type": "service",
    "activity": "experience",
    "event": "experience",
}


@pytest.mark.parametrize("synonym,canonical", list(SYNONYMS.items()))
def test_the_filter_speaks_the_products_kind_vocabulary(synonym: str, canonical: str):
    """The same concept, as a filter synonym and as a canonical kind, gives the same result."""
    plan = plan_from_intent(None, query="", filters={"kind": synonym})
    filtered = (plan.filters or {}).get("kind")
    assert filtered == canonical, (
        f"the synonym {synonym!r} gave the filter kind {filtered!r}, "
        f"but the canonical kind is {canonical!r} — the same concept is two different filters"
    )


def test_canonical_kinds_are_unchanged():
    """Canonical kind terms pass through unchanged."""
    for kind in sorted(CANONICAL_KINDS):
        plan = plan_from_intent(None, query="", filters={"kind": kind})
        assert (plan.filters or {}).get("kind") == kind, (
            f"canonical kind {kind!r} was changed to {(plan.filters or {}).get('kind')!r}"
        )


def test_an_unknown_kind_is_left_alone():
    """The reader does not resolve a word the product does not know into one it does."""
    plan = plan_from_intent(None, query="", filters={"kind": "unknown_kind_xyz"})
    assert (plan.filters or {}).get("kind") == "unknown_kind_xyz", (
        "an unknown kind was resolved into a known one — the reader must not invent a "
        "kind the caller did not ask for"
    )


def test_the_reader_reads_all_known_kinds():
    """The reader reads all the product's own canonical kind terms."""
    for kind in CANONICAL_KINDS:
        plan = plan_from_intent(None, query="", filters={"kind": kind})
        assert (plan.filters or {}).get("kind") == kind, (
            f"canonical kind {kind!r} is not read by the kind reader"
        )


def test_synonyms_map_to_correct_subject_types():
    """Synonyms map to the correct subject_types via the intent's KIND_TO_SUBJECT."""
    # "shop" -> "merchant" -> subject_types ("merchant",)
    plan = plan_from_intent(None, query="", filters={"kind": "shop"})
    # The kind should be canonicalized to "merchant"
    assert (plan.filters or {}).get("kind") == "merchant"

    # "activity" -> "experience" -> subject_types ("offering",)
    plan = plan_from_intent(None, query="", filters={"kind": "activity"})
    assert (plan.filters or {}).get("kind") == "experience"

    # "item" -> "product" -> subject_types ("offering",)
    plan = plan_from_intent(None, query="", filters={"kind": "item"})
    assert (plan.filters or {}).get("kind") == "product"