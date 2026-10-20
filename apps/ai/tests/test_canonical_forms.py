"""D417 - the vocabulary and the query speak the same spelling.

`nlu/canonical.py` is a table of the characters this product's vocabulary uses, in the
standard spelling, built from the Unihan database. It is applied to BOTH sides of every
comparison: the query (in `normalize_query` and in the matchers) and the vocabulary terms
(at import). So a user who types 餐厅 and a vocabulary written 餐廳 meet in the middle,
and the answer is the same either way.

These cases pin the properties the fix depends on:
  * the canonicalisation is IDEMPOTENT and it is an EQUIVALENCE (both spellings land on
    the same form, so a term and a query always meet);
  * the vocabulary holds the canonical form of every character it uses;
  * the query text that goes to SQL is NOT canonicalised - the corpus is indexed as it
    is, and rewriting the text matched against that index would change which rows match.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical


def test_the_canonicalisation_is_idempotent():
    for ch, canon in CANONICAL_FORMS.items():
        assert canonical(canon) == canon, (
            f"U+{ord(canon):04X} is not canonical - the table is not an equivalence")
        assert canonical(ch) == canon


def test_the_table_only_moves_characters_to_their_standard_form():
    # Every entry is a single character to a single character: a table that moved a WHOLE
    # TERM would rewrite words, and 座位 must not become 庢位.
    for ch, canon in CANONICAL_FORMS.items():
        assert len(ch) == 1 and len(canon) == 1, (
            f"the table moves {ch!r} to {canon!r}, which is more than a character")


def test_the_vocabulary_holds_the_canonical_form_of_every_character():
    tables = {
        "CATEGORY_SYNONYMS": L.CATEGORY_SYNONYMS,
        "CUISINE_TERMS": L.CUISINE_TERMS,
        "SORT_RULES": L.SORT_RULES,
        "CONSTRAINT_RULES": L.CONSTRAINT_RULES,
        "DISTRICTS": getattr(L, "DISTRICTS", {}),
        "PREFERENCE_RULES": getattr(L, "PREFERENCE_RULES", {}),
    }
    for name, table in tables.items():
        for ch in repr(table):
            if not ("\u4e00" <= ch <= "\u9fff"):
                continue
            assert canonical(ch) == ch, (
                f"{name} carries U+{ord(ch):04X}, which is not the canonical form")


def test_both_spellings_reach_the_matcher():
    # 餐廳 / 餐厅 and 食飯 / 食饭: the vocabulary holds one spelling, the user may type
    # either, and the answer is the same.
    assert L.match_category("\u9910\u5ef3")[0] == "restaurant"
    assert L.match_category("\u9910\u5385")[0] == "restaurant"
    assert L.match_category("\u98df\u98ef")[0] == "restaurant"
    assert L.match_category("\u98df\u996d")[0] == "restaurant"
    assert L.match_cuisines("\u53c3\u96de\u6e6f") == L.match_cuisines("\u53c2\u9d8f\u6e6f")


def test_the_query_text_that_goes_to_sql_is_not_canonicalised():
    # The corpus is indexed as it is: the plan's query text is the RAW query, so the
    # index still matches the rows it was built from. Canonicalising it would change
    # WHICH rows match - a separate measurement, filed, not assumed.
    from nexus_ai.search import service as S

    plan = S.plan_from_intent(None, query="\u9910\u5385")
    assert plan.query_text == "\u9910\u5385"
    assert canonical(plan.query_text) != plan.query_text  # the canonical form is different


def test_the_normalised_query_is_canonical():
    assert L.normalize_query("\u9910\u5385") == "\u9910\u5ef3"
