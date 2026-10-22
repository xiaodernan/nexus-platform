"""D480 - the first turn's REMAINING readers read their tables as WORDS.

D479 gave the intent tables the ONE matcher. The readers of the OTHER tables - the
urgency, the budget words, the sort rules, the preferences, the price words, the nearby
terms and the constraint negations - still tested their tables with `in low`, so:

  * "know a good cafe"   -> the urgency was NOW    (the token "now" inside "know")
  * "nowhere near a cafe" -> the urgency was NOW    (the token "now" inside "nowhere")
  * "underground coffee"  -> the sort was PRICE_LOW (the token "under" inside
                             "underground") - the search answered in the wrong order
  * "review a cafe"       -> the preference was a SCENIC VIEW (the token "view")

This gate takes its parameters from the tables themselves, so the tables grow and the gate
grows with them: every token must reach its own effect, and no token may be read out of
the middle of a word.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import understand as U
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: the tables the first turn reads, and the field each one fills
URGENCY_TABLES = [("URGENCY_NOW", "now"), ("URGENCY_FLEXIBLE", "flexible")]


def _tokens() -> list[tuple[str, str]]:
    """Every token of every table the first turn reads."""
    out: list[tuple[str, str]] = []
    for name, _ in URGENCY_TABLES:
        out.extend((name, tok) for tok in getattr(L, name))
    for pref, tokens in L.SORT_RULES:
        out.extend((f"SORT_RULES[{pref}]", tok) for tok in tokens)
    for key, value, tokens, _ in L.PREFERENCE_RULES:
        out.extend((f"PREFERENCE_RULES[{key}={value}]", tok) for tok in tokens)
    out.extend(("NEARBY_TERMS", tok) for tok in L.NEARBY_TERMS)
    return out


def _latin_tokens() -> list[tuple[str, str]]:
    """The Latin tokens - the ones a word can sit inside."""
    return [row for row in _tokens() if row[1].isascii()]


def _signature(text: str) -> tuple:
    intent = extract_intent(text, {})
    return (intent.intent, intent.urgency, intent.sort_preference,
            tuple((p.get("key"), p.get("value")) for p in intent.preferences),
            intent.location.get("type") if intent.location else None)


@pytest.mark.parametrize("name,token", _latin_tokens())
def test_a_latin_token_is_not_read_out_of_the_middle_of_a_word(name: str, token: str):
    """A letter glued to the token's left must take the token out of the text."""
    glued = "x" + token
    assert not cue_in(token, glued, glued.lower()), (
        f"{name}'s token {token!r} was read out of the middle of a word - \"now\" inside "
        f"\"know\" made the query urgent, and \"under\" inside \"underground\" made it a "
        f"price search")
    assert cue_in(token, token, token.lower()), (
        f"{name}'s token {token!r} does not match itself - a table's entry is a promise")


@pytest.mark.parametrize("name,token", _tokens())
def test_a_token_still_reaches_its_own_effect(name: str, token: str):
    """The readers must still do their work - the fix must not cost the product anything."""
    if name in ("URGENCY_NOW", "URGENCY_FLEXIBLE"):
        wanted = dict(URGENCY_TABLES)[name]
        assert extract_intent(token, {}).urgency == wanted, (
            f"{name}'s token {token!r} no longer reads as {wanted!r}")
    elif name.startswith("SORT_RULES"):
        wanted = name[len("SORT_RULES["):-1]
        assert extract_intent(token, {}).sort_preference == wanted, (
            f"{name}'s token {token!r} no longer sorts by {wanted!r}")
    elif name.startswith("PREFERENCE_RULES"):
        key, value = name[len("PREFERENCE_RULES["):-1].split("=", 1)
        preferences = {(p.get("key"), p.get("value"))
                       for p in extract_intent(token, {}).preferences}
        assert (key, value) in preferences, (
            f"{name}'s token {token!r} no longer reads as the preference {key}={value!r}")
    elif name == "NEARBY_TERMS":
        location = extract_intent(token, {}).location or {}
        assert location.get("type") == "nearby", (
            f"NEARBY_TERMS's token {token!r} no longer reads as a nearby place")


def test_no_token_sits_in_two_rows_of_one_reader():
    """The same word in two rows is unreachable in the second one.

    D480: the sort rules held the word U+6700 U+53D7 U+6B61 U+8FCE in the rating row AND
    in the trending row. The sort reader takes the first row that matches, so the rating
    row's copy always won and the trending row's copy was a promise nobody kept (D477).
    """
    for name, rows in (("SORT_RULES", L.SORT_RULES),
                       ("the urgency tables", [(n, getattr(L, n))
                                               for n, _ in URGENCY_TABLES])):
        seen: dict[str, str] = {}
        for label, tokens in rows:
            for token in tokens:
                if token in seen and seen[token] != label:
                    pytest.fail(
                        f"the token {token.encode('unicode_escape').decode()!r} sits in "
                        f"both {seen[token]} and {label} - the reader takes the first, so "
                        f"the other is unreachable")
                seen[token] = label


def test_the_urgency_is_not_read_out_of_a_word():
    """The measured instances."""
    for text in ("know a good cafe in sha tin", "knowledge of good coffee",
                 "nowhere near a cafe"):
        assert extract_intent(text, {}).urgency == "normal", (
            f"{text!r} was answered as an URGENT query - the token 'now' was read out of "
            f"the word")


def test_the_sort_is_not_read_out_of_a_word():
    assert extract_intent("underground coffee", {}).sort_preference == "relevance", (
        "'underground' was answered as a PRICE search - the token 'under' was read out of "
        "the word")


def test_the_preferences_are_not_read_out_of_a_word():
    for text, preference in (("review a cafe", ("view", "scenic")),
                              ("console cafe", ("occasion", "solo")),
                              ("candidates cafe", ("occasion", "date"))):
        preferences = {(p.get("key"), p.get("value"))
                       for p in extract_intent(text, {}).preferences}
        assert preference not in preferences, (
            f"{text!r} was answered with the preference {preference!r} - the token was "
            f"read out of the word")


def test_the_budget_words_are_not_read_out_of_a_word():
    assert not U._has_budget_word("underground coffee"), (
        "'underground' was read as a stated budget - the token 'under' was read out of the "
        "word")
    assert U._has_budget_word("coffee under 100 dollars")


def test_the_constraint_negations_are_not_read_out_of_a_word():
    """'no' inside 'notebook' is not a negation."""
    constraints = {(c.get("key"), c.get("value"))
                   for c in extract_intent("notebook cafe", {}).constraints}
    assert not constraints, (
        f"'notebook' was answered with the constraints {constraints} - the negation 'no' "
        f"was read out of the word")


def test_the_constraint_reader_still_works():
    constraints = {(c.get("key"), c.get("value"))
                   for c in extract_intent("no peanuts please", {}).constraints}
    assert constraints, "the constraint reader stopped working - 'no peanuts' is a request"
