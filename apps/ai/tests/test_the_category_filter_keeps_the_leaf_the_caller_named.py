"""D524 - the category filter keeps the leaf the caller named.

`filters.category` is read by the SAME reader as the intent's category (D505), and that
reader answers with a coarse BUCKET. For 21 of the taxonomy's 67 leaves the bucket is
COARSER than what the caller wrote, because the leaf's own name contains a word the reader
also knows - "coffee" is a word inside `specialty-coffee`, "salon" inside `hair-salon`,
"bar" inside `cocktail-bar` (a hyphen is a word boundary). The leaf was rewritten into its
root and the caller's hard filter (§7.1) silently became the whole root.

Measured on the live corpus before the fix, `query=""` with

    filters={"category": "specialty-coffee"}  -> 79 merchants  (the corpus holds 33)
    filters={"category": "cocktail-bar"}      -> 39 merchants  (the corpus holds 13)
    filters={"category": "hair-salon"}        -> 39 merchants  (the corpus holds 11)

and after the fix all three answer exactly what the corpus holds, while a root
(`cafe` -> 79) and a word (`coffee` -> the cafe bucket) are unchanged.

The taxonomy is the only plane that knows which slugs are leaves, so the caller's own
spelling travels beside the bucket and the SQL asks the taxonomy: an exact leaf wins, the
bucket walk is the fallback.

It was **proved to fail**: dropping `category_spelling` from the plan reddens the live
checks (the probe was put back).
"""

from __future__ import annotations

import pytest

from nexus_ai.search import sql as S
from nexus_ai.search.service import plan_from_intent

#: (the leaf the caller names, the bucket the reader answers with, the corpus count on the
#: live database, measured 2026-10-23 against `categories`/`merchant_categories`)
LEAVES = [
    ("specialty-coffee", "cafe", 33),
    ("cocktail-bar", "bar", 13),
    ("hair-salon", "beauty", 11),
    ("spa-massage", "beauty", 8),
    ("nail-salon", "beauty", 14),
    ("boutique-hotel", "hotel", 11),
    ("resort", "hotel", 9),
    ("food-tour", "restaurant", 6),
    ("sports-pub", "bar", 21),
    ("wine-bar", "bar", 18),
    ("gym-club", "gym", 3),
    ("skin-clinic", "medical", 13),
]


@pytest.mark.parametrize("leaf,bucket,_n", LEAVES, ids=[row[0] for row in LEAVES])
def test_the_planner_keeps_the_callers_own_spelling(leaf, bucket, _n):
    """The bucket the reader answers with is kept - and so is what the caller wrote."""
    filters = plan_from_intent(None, query="", filters={"category": leaf}).filters
    assert filters.get("category") == bucket, (
        f"the reader no longer answers with the bucket {bucket!r} for {leaf!r}")
    assert filters.get("category_spelling") == leaf, (
        f"the caller's own spelling of {leaf!r} was dropped - the filter is now the bucket "
        f"{filters.get('category')!r}, which stands for the whole root")


def test_the_spelling_is_the_respelled_one():
    """The ONE separator rule, the same one the tags filter uses (D516)."""
    filters = plan_from_intent(None, query="", filters={"category": " Hair-Salon "}).filters
    assert filters.get("category_spelling") == "hair-salon"


def test_no_spelling_when_the_caller_named_none():
    """The intent's own category is a bucket already; nothing is invented for it."""
    filters = plan_from_intent(None, query="", filters={}).filters
    assert "category_spelling" not in filters


def test_the_clause_prefers_an_exact_leaf():
    """The coupling: the SQL asks the taxonomy before it walks up to the root."""
    source = open(S.__file__, encoding="utf-8").read()
    assert "category_spelling" in source, (
        "the SQL never sees the caller's own spelling, so a leaf cannot be matched exactly")
    assert "parent_id IS NOT NULL" in source, (
        "the clause does not ask the taxonomy whether the spelling names a LEAF, so it "
        "cannot prefer an exact leaf over the bucket walk")


def test_the_clause_binds_both_sets_of_slugs():
    p = S.Params()
    S.category_clause(p, "cafe", "m.id", "specialty-coffee")
    bound = [v for v in p.values if isinstance(v, list)]
    assert ["cafe"] in bound and ["specialty-coffee"] in bound, (
        f"the clause bound {bound} - the bucket and the caller's spelling must both be there")


def test_a_root_still_walks_one_tree_level():
    """The bucket path is intact: a root must still answer with its whole subtree."""
    p = S.Params()
    clause = S.category_clause(p, "cafe", "m.id", "cafe")
    assert "pc.slug" in clause, "the root walk is gone - a root answers with nothing now"


def test_an_unknown_word_still_falls_back_to_the_bucket():
    p = S.Params()
    clause = S.category_clause(p, "cafe", "m.id", "banana")
    assert clause is not None and "pc.slug" in clause, (
        "a word the taxonomy does not carry lost the bucket walk")
