"""D482 - the trust layer's claim kind, and the RAG's containment test.

The trust layer types a bare number by the word near it, and the kind decides the
grounding tolerance (§4): a money claim typed as a plain number is grounded with the
loose number tolerance, so a price can be grounded by a rating fact. The window was six
characters - shorter than most English clauses - and the keyword list stood inside the
reader, without the English "star".

    "the price is 128"   -> the claim kind NUMBER (the window was "ce is 128")
    "a 4.5 star rating"  -> the claim kind NUMBER (the English "star" was not listed)

The RAG's containment test read the query's tokens as bare substrings, so "spa" matched
"spaghetti" and "tea" matched "steakhouse" - and the containment is the EVIDENCE the route
uses to decide whether a chunk answers the question (D405).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.matching import cue_in
from nexus_ai.search.tokens import mentions
from nexus_ai.trust.verification import (
    MONEY_KIND,
    MONEY_KEYWORDS,
    NUMBER_KIND,
    RATING_KEYWORDS,
    RATING_KIND,
    extract_claims,
)


def _kinds(text: str) -> list[tuple[str, object]]:
    return [(c.kind, c.value) for c in extract_claims(text)]


def test_a_price_is_a_money_claim():
    assert _kinds("the price is 128") == [(MONEY_KIND, 128.0)], (
        f"the claim was typed {_kinds('the price is 128')!r} - the word that types the "
        f"claim must be inside the window")


def test_a_budget_is_a_money_claim():
    assert _kinds("the budget is 500") == [(MONEY_KIND, 500.0)]


def test_a_star_rating_is_a_rating_claim():
    assert _kinds("a 4.5 star rating") == [(RATING_KIND, 4.5)], (
        f"the claim was typed {_kinds('a 4.5 star rating')!r} - the English \"star\" is a "
        f"rating word")


def test_a_bare_number_is_a_number_claim():
    assert _kinds("it costs 128") == [(NUMBER_KIND, 128.0)], (
        "a number with no word typing it is a plain number - the product must not invent "
        "a kind")


@pytest.mark.parametrize("keyword", [k for k in MONEY_KEYWORDS + RATING_KEYWORDS
                                     if k.isascii()])
def test_a_latin_keyword_is_not_read_out_of_the_middle_of_a_word(keyword: str):
    """A letter glued to the keyword's left must take the keyword out of the text."""
    glued = "x" + keyword
    assert not cue_in(keyword, glued, glued.lower()), (
        f"the keyword {keyword!r} was read out of the middle of a word - \"priceless\" is "
        f"not \"price\"")
    assert cue_in(keyword, keyword, keyword.lower())


def test_a_priceless_number_is_not_a_money_claim():
    assert _kinds("a priceless 300") == [(NUMBER_KIND, 300.0)], (
        "'priceless' typed the claim as money - the keyword was read out of the word")


def test_a_chinese_price_is_a_money_claim():
    """The Chinese keyword still reaches its claim - the window is the CJK one there."""
    assert _kinds("價 128") == [(MONEY_KIND, 128.0)], (
        f"the claim was typed {_kinds('價 128')!r} - the Chinese keyword must still reach "
        f"its claim")


@pytest.mark.parametrize("keyword", [k for k in MONEY_KEYWORDS + RATING_KEYWORDS
                                     if not k.isascii()])
def test_a_cjk_keyword_still_reads(keyword: str):
    """The CJK keywords are read on their own spelling - a CJK marker has no word inside."""
    assert cue_in(keyword, keyword, keyword.lower()), (
        f"the keyword {keyword.encode('unicode_escape').decode()!r} does not match itself")


def test_the_containment_test_reads_words():
    assert not mentions("spaghetti bolognese", "spa"), (
        "'spa' matched inside 'spaghetti' - the containment test must read words")
    assert not mentions("steakhouse", "tea")
    assert mentions("ramen stall", "ramen")
    assert mentions("bars and grills", "bar"), (
        "a plural still matches - 'bar' in 'bars' is a bar")
