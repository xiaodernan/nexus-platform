"""D522 - a negated cuisine is a dislike, in Chinese as in English.

`apply_polarity` re-stamps the polarity of EVERY preference on the Intent, and its contract
is explicit: `tokens` maps a preference's (key, value) to the SURFACE term that matched it,
"because the canonical value is not in a Chinese sentence, but the token that matched is"
(polarity.py). The cuisine preferences are put on the Intent by `_fill_category`, which
appended them with no token at all - so the reader fell back to the canonical value, and a
Chinese sentence negating a cuisine carried none of it.

Measured before the fix, every one of these came back polarity **+1** - a LIKE of the very
cuisine the user refused, which the ranking lane then BOOSTS (a matched cuisine scores 1.0
at polarity +1 and 0.0 at -1):

    "\u7d20\u98df\u5514\u597d"             -> cuisine=vegetarian, polarity +1
    "\u5514\u597d\u7d20\u98df"             -> cuisine=vegetarian, polarity +1
    "\u4e0d\u60f3\u5403\u6d77\u9c9c"          -> cuisine=seafood,    polarity +1
    "\u4e0d\u8981\u65e5\u6599"             -> cuisine=japanese,   polarity +1
    "\u98df\u4e48\u90fd\u597d \u5514\u597d\u65e5\u5f0f" -> cuisine=japanese,   polarity +1

The English rows worked, and only by luck of the same fallback: "no seafood" happens to
carry the canonical value inside the sentence. Nothing was wrong with the polarity grammar -
the reader was being handed the wrong word.

This gate holds the coupling, not just the instances: for EVERY row of the table, the
cuisine's own term negated reads -1 and affirmed reads +1, and the token map is built from
the ONE cuisine matcher rather than from a copy.

It was **proved to fail**: reverting `_fill_preferences` to build `matched_tokens` from
`PREFERENCE_RULES` alone reddens every negated check here (the probe was put back).
"""

from __future__ import annotations

import inspect

import pytest

from nexus_ai.nlu import understand
from nexus_ai.nlu.lexicon import CUISINE_TERMS
from nexus_ai.nlu.understand import extract_intent

#: the negation cue the gate puts before / after a cuisine's own term
CUE = "\u5514\u597d"


def _own_cjk_term(cuisine: str) -> str:
    """The cuisine's first Chinese term - the word a Cantonese user actually types."""
    for term in CUISINE_TERMS[cuisine]:
        if not term.isascii():
            return term
    raise AssertionError(f"{cuisine} has no Chinese term to negate")


def _polarity(query: str, cuisine: str) -> int | None:
    prefs = [p for p in extract_intent(query).to_dict().get("preferences", [])
             if p.get("key") == "cuisine" and p.get("value") == cuisine]
    return prefs[0]["polarity"] if prefs else None


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_a_negated_cuisine_is_a_dislike(cuisine):
    """The cue before the term, and the cue after it: both are a refusal."""
    term = _own_cjk_term(cuisine)
    assert _polarity(CUE + term, cuisine) == -1, (
        f"{CUE + term!r} was not read as a refusal of {cuisine} - the reader never saw the "
        f"negation, so the ranking lane boosts the cuisine the user ruled out")
    assert _polarity(term + CUE, cuisine) == -1, (
        f"{term + CUE!r} was not read as a refusal of {cuisine}")


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_an_affirmed_cuisine_stays_a_like(cuisine):
    """The gate must not have been passed by negating everything."""
    term = _own_cjk_term(cuisine)
    assert _polarity("\u60f3\u98df" + term, cuisine) == 1, (
        f"an affirmed {cuisine} was not read as a like")


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_an_english_negation_of_a_cuisine_is_a_dislike(cuisine):
    name = cuisine.replace("_", " ")
    assert _polarity("not " + name, cuisine) == -1, (
        f"'not {name}' was not read as a refusal of {cuisine}")
    assert _polarity("no " + name, cuisine) == -1


def test_the_token_map_is_built_from_the_one_cuisine_matcher():
    """The coupling: the token the polarity reader is handed comes from the lexicon's ONE
    cuisine matcher, not from a second copy of the matching rule (the D518 lesson)."""
    source = inspect.getsource(understand._fill_preferences)
    assert "match_cuisine_terms" in source, (
        "the cuisine preferences are re-stamped by apply_polarity without the surface term "
        "that matched them - a Chinese negation is invisible to the reader")
    assert "apply_polarity(ex.preferences, text, matched_tokens)" in source, (
        "the token map no longer reaches the polarity reader")


def test_the_measured_instances():
    assert _polarity("\u4e0d\u60f3\u5403\u6d77\u9c9c", "seafood") == -1
    assert _polarity("\u4e0d\u8981\u65e5\u6599", "japanese") == -1
    assert _polarity("\u98df\u4e48\u90fd\u597d \u5514\u597d\u65e5\u5f0f", "japanese") == -1
    assert _polarity("\u7d20\u98df\u5514\u597d", "vegetarian") == -1
