"""D395 - the "X-style" form is how a HK user asks for a cuisine (§7.1 / §111).

Only two of the eleven cuisine rows carried the "X-style" (X式) form, so "日式菜" — the most
common way a Hong Kong user asks for Japanese food — resolved to nothing at all: no cuisine, no
category, and a page that answered with the search's first 5 merchants rather than the ones
the user asked for.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import CUISINE_TERMS, match_cuisines, normalize_query
from nexus_ai.nlu.understand import extract_intent


# --------------------------------------------------------------------------- the vocabulary
@pytest.mark.parametrize("text,cuisine", [
    ("日式", "japanese"),        # 日式
    ("日式菜", "japanese"),       # 日式菜
    ("泰式", "thai"),             # 泰式
    ("泰式菜", "thai"),           # 泰式菜
    ("中式", "cantonese"),        # 中式
    ("西式", "western"),          # 西式
    ("意式", "italian"),          # 意式
    ("韓式", "korean"),           # 韓式
    ("馬來西亞菜", "malaysian"),  # 馬來西亞菜
    ("素菜", "vegetarian"),      # 素菜
])
def test_the_style_form_resolves_to_its_cuisine(text, cuisine):
    assert cuisine in match_cuisines(normalize_query(text))


def test_the_style_form_is_carried_by_the_row_not_by_a_side_table():
    # The rows are the single source of truth: a form that is not IN the row is a form
    # the matcher cannot see.
    assert "日式" in CUISINE_TERMS["japanese"]
    assert "中式" in CUISINE_TERMS["cantonese"]


def test_the_existing_forms_still_resolve():
    # The addition must not have displaced what already worked.
    assert "japanese" in match_cuisines(normalize_query("日料"))     # 日料
    assert "cantonese" in match_cuisines(normalize_query("粵菜"))     # 粵菜
    assert "thai" in match_cuisines(normalize_query("泰式"))         # 泰式
    assert "italian" in match_cuisines(normalize_query("italian"))


# --------------------------------------------------------------------------- the extractor
def test_a_style_form_query_resolves_a_cuisine_and_a_category():
    ex = extract_intent("我想食日式菜", {"locale": "zh-HK"})
    assert ex.category == "restaurant"
    cuisines = [p for p in ex.preferences if p["key"] == "cuisine"]
    assert cuisines and cuisines[0]["value"] == "japanese"


def test_a_style_form_query_that_did_not_work_before_now_does():
    # The measurement that started this unit: this query resolved to nothing at all.
    ex = extract_intent("想食日式菜", {"locale": "zh-HK"})
    assert ex.intent == "discover_merchant"
    assert ex.category is not None
    assert ex.preferences
