"""D488 - the two readers must answer the same question the same way.

The merge and the first turn read the same tables - the lexin's - and the fields they
both fill must come out the same. The merge used to read the constraints with its own
hand-written regexes (a second reader of the same vocabulary, and a SUBSET of it), so the
merge added the SAME constraint twice, in two spellings:

    "I don't eat pork"
      the first turn   [('diet_avoid', 'pork')]
      the merge        [('diet_avoid', 'pork'), ('diet_avoid', '豬')]

This gate asks both readers the same question about every word of the tables they share,
and compares the answers field by field - the merge keeps the carried state for the
fields a turn does not mention, so only the fields the merge CHANGED are compared.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu.understand import extract_intent

BASE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}

#: the words the two readers share
URGENCY_WORDS = tuple(L.URGENCY_NOW) + tuple(L.URGENCY_FLEXIBLE)
CONSTRAINT_WORDS = tuple(f"{negation}{value}"
                          for _key, negs, values in L.CONSTRAINT_RULES
                          for negation in negs[:1] for value in values[:2])
CATEGORY_WORDS = tuple(term for _cat, terms in L.CATEGORY_SYNONYMS.items()
                       for term in terms[:1])


def _compare(text: str) -> list[tuple]:
    """The fields the merge changed, read by the merge and by the first turn."""
    result = M.merge_turn(dict(BASE), text)
    intent = result.intent
    first = extract_intent(text, {})
    changed = {str(change.get("field")) for change in (result.changes or [])}
    out: list[tuple] = []
    for field, merged_value, first_value in (
            ("category", intent.get("category"), first.category),
            ("urgency", intent.get("urgency"), first.urgency),
            ("sort_preference", intent.get("sort_preference"), first.sort_preference),
            ("party_size", intent.get("party_size"), first.party_size)):
        if field in changed:
            out.append((field, merged_value, first_value))
    merged_constraints = sorted((c.get("key"), c.get("value"))
                                for c in intent.get("constraints", []))
    first_constraints = sorted((c.get("key"), c.get("value")) for c in first.constraints)
    if merged_constraints:
        out.append(("constraints", merged_constraints, first_constraints))
    return out


def _check(text: str) -> None:
    for field, merged_value, first_value in _compare(text):
        assert merged_value == first_value, (
            f"the word {text.encode('unicode_escape').decode()!r} was read differently by "
            f"the two readers - the {field} is {merged_value!r} in the merge and "
            f"{first_value!r} in the first turn")


@pytest.mark.parametrize("word", URGENCY_WORDS,
                         ids=[w.encode("unicode_escape").decode() for w in URGENCY_WORDS])
def test_the_urgency_reads_the_same(word: str):
    _check(word)


@pytest.mark.parametrize("word", CONSTRAINT_WORDS,
                         ids=[w.encode("unicode_escape").decode() for w in CONSTRAINT_WORDS])
def test_the_constraints_read_the_same(word: str):
    _check(word)


@pytest.mark.parametrize("word", CATEGORY_WORDS,
                         ids=[w.encode("unicode_escape").decode() for w in CATEGORY_WORDS])
def test_the_category_reads_the_same(word: str):
    _check(word)


def test_the_merge_has_no_constraint_rules_of_its_own():
    """The second reader is gone - the residual absorb reads the lexin's table."""
    import inspect

    source = inspect.getsource(M)
    assert "diet_avoid" not in source, (
        "the state merger reads a constraint of its own again - the constraints are read by "
        "the ONE reader, the lexin's table")
