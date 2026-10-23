"""D517 - the search's `avoid` filter speaks the corpus's OWN vocabulary, and the caller's
own list survives the planner.

Two defects in one lane, both the D488 shape (the same fact read by two readers, one of them
the raw string):

1. `plan_from_intent` ended with `out["avoid"] = plan.avoid`, and `plan.avoid` holds only
   what the INTENT's constraints named. So a caller who sent `{"avoid": ["pork"]}` alongside
   an intent that named nothing had their hard filter overwritten by an empty list - and the
   empty-filter sweep then dropped the key altogether. Measured: `plan.filters` carried no
   `avoid` at all. §7.1 says the request's filters are HARD.

2. The SQL avoid clause compared the canonical constraint token to `m.category_primary` with
   `=` and to the offering names with ILIKE. The taxonomy's leaf for the same word is
   `seafood-grill`, and the column stores the leaf's NAME ("Seafood & BBQ"), so neither leg
   could fire. Measured on the live corpus: `avoid=["seafood"]` removed 16 of 470 published
   merchants, and all 14 published merchants tagged `seafood-grill` survived it.

This gate holds both:
  * the caller's explicit list reaches the plan, merged with the intent's constraints;
  * the term set the SQL binds is the corpus's vocabulary, read through the lexin's OWN
    cuisine bridge - the same reader the preference lane uses (D394).

It was **proved to fail**: reverting either half reddens these checks (the probe was put
back).
"""

from __future__ import annotations

import pytest

from nexus_ai.contract import Intent
from nexus_ai.nlu.lexicon import CUISINE_LEAVES, cuisine_leaves
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search import sql as S
from nexus_ai.search.categories import avoid_terms
from nexus_ai.search.service import DEFAULT_TENANT_ID, plan_from_intent

TENANT = DEFAULT_TENANT_ID


def _intent(**overrides) -> Intent:
    d = extract_intent_dict("\u6435\u9910\u5ef3")
    d.update(overrides)
    return Intent.model_validate(d)


# ------------------------------------------------------------------ the vocabulary
@pytest.mark.parametrize("word", sorted(CUISINE_LEAVES), ids=sorted(CUISINE_LEAVES))
def test_the_avoid_term_set_contains_every_leaf_the_bridge_names(word):
    """One word, one set of spellings: whatever the lexin's bridge says the word stands for
    is in the set the SQL binds."""
    terms = avoid_terms(word)
    for leaf in cuisine_leaves(word):
        assert leaf in terms, (
            f"the bridge says {word!r} stands for {leaf!r}, but the avoid term set is "
            f"{terms!r} - the two readers disagree about one word")


@pytest.mark.parametrize("word", sorted(CUISINE_LEAVES), ids=sorted(CUISINE_LEAVES))
def test_every_spelling_of_a_word_reaches_the_same_leaves(word):
    """`dim_sum`, `dim-sum` and `Dim Sum` are one word, so they reach the same leaves."""
    expected = {t for spelling in (word, word.replace("_", "-"), word.replace("-", "_"))
                for t in cuisine_leaves(spelling)}
    for spelling in (word, word.upper(), f"  {word}  ", word.replace("_", " ")):
        terms = set(avoid_terms(spelling))
        assert expected <= terms, (
            f"the spelling {spelling!r} reached {sorted(terms)} and missed "
            f"{sorted(expected - terms)}")


def test_an_unknown_word_still_contributes_its_own_spellings():
    """A cuisine the taxonomy does not know is still a word a merchant may carry in its
    tags, so the reader must not drop it."""
    assert avoid_terms("unknown_thing") == ["unknown_thing", "unknown-thing"]


def test_nothing_asked_means_no_terms():
    assert avoid_terms("") == []
    assert avoid_terms(None) == []
    assert avoid_terms("   ") == []


# ------------------------------------------------------------------ the SQL
@pytest.mark.parametrize("lane,kwargs", [
    ("merchant", {"text": "", "embedding": None, "filters": {"avoid": ["seafood"]}}),
    ("offering", {"text": "", "filters": {"avoid": ["seafood"]}}),
], ids=["merchant", "offering"])
def test_the_avoid_clause_reads_the_tags_column(lane, kwargs):
    """The corpus records the fact in `tags`; a clause that never reads it cannot exclude."""
    q = (S.build_merchant_query if lane == "merchant" else S.build_offering_query)(
        tenant_id=TENANT, **kwargs)
    assert "m.tags &&" in q.sql, (
        f"the {lane} lane's avoid clause never reads the tags column, so the one place the "
        f"corpus records a cuisine is invisible to it")
    assert ["seafood", "seafood-grill"] in q.params, (
        f"the {lane} lane bound {q.params} - the raw token, not the corpus's vocabulary")


def test_the_two_lanes_bind_the_same_term_set():
    """Two readers of one fact must agree, or the lanes exclude different merchants."""
    m = S.build_merchant_query(tenant_id=TENANT, text="", embedding=None,
                               filters={"avoid": ["seafood"]})
    o = S.build_offering_query(tenant_id=TENANT, text="", filters={"avoid": ["seafood"]})
    assert [p for p in m.params if isinstance(p, list)] == [
        p for p in o.params if isinstance(p, list)]


def test_an_empty_avoid_list_binds_no_clause():
    q = S.build_merchant_query(tenant_id=TENANT, text="", embedding=None, filters={"avoid": []})
    assert "AND NOT (" not in q.sql


# ------------------------------------------------------------------ the planner
def test_the_callers_explicit_avoid_survives_the_intent_path():
    """§7.1: the request's filters are hard. An intent must not overwrite them."""
    plan = plan_from_intent(_intent(), filters={"avoid": ["pork"]})
    assert plan.filters.get("avoid") == ["pork"], (
        "the caller's explicit avoid list was overwritten by the intent's - a hard filter "
        "silently became no filter at all")


def test_the_callers_list_and_the_intents_constraints_are_merged():
    plan = plan_from_intent(
        _intent(constraints=[{"key": "cuisine_avoid", "value": "spicy"}]),
        filters={"avoid": ["pork", "beef"]})
    assert plan.filters.get("avoid") == ["pork", "beef", "spicy"]


def test_the_merge_is_deduped_and_order_stable():
    a = plan_from_intent(_intent(), filters={"avoid": ["pork", "pork"]}).filters.get("avoid")
    b = plan_from_intent(_intent(), filters={"avoid": ["pork", "pork"]}).filters.get("avoid")
    assert a == b == ["pork"]


def test_an_empty_avoid_list_stays_absent():
    plan = plan_from_intent(_intent(), filters={"avoid": []})
    assert "avoid" not in plan.filters


def test_the_intent_none_branch_keeps_the_callers_list_too():
    plan = plan_from_intent(None, filters={"avoid": ["pork"]})
    assert plan.filters.get("avoid") == ["pork"]
