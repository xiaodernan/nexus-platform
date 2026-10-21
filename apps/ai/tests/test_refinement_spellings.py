"""D436 - a cue that answers to ONE spelling is half a cue.

D421 canonicalises the merge's cue lists at import, so the lists hold one spelling per
word - and the canonical form is the Traditional one (every pair in the canonical table
points that way). The user's text is canonicalised too, so the two meet and the merge
answers to either spelling.

That is the property, and it is easy to LOSE: a test that reads "the two spellings" out
of such a list reads the SAME word twice, and then reports the property it never
measured. D433's test did exactly that - the Simplified spelling of the refinement was
never run.

So this file holds the property itself, as a gate over EVERY cue the merge compares
against: the canonical spelling and the other spelling must produce the SAME refinement.
"""

from __future__ import annotations

from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical

#: The canonical table's reverse map: the Traditional form -> the Simplified one.
_REVERSE = {value: key for key, value in CANONICAL_FORMS.items()}


def _other_spelling(text: str) -> str:
    return "".join(_REVERSE.get(ch, ch) for ch in text)


def _base_intent() -> dict:
    return {
        "intent": "discover_merchant", "raw_query": "拉麵", "unknowns": [],
        "language": "zh-HK", "budget": None, "party_size": None, "location": {},
        "preferences": [], "constraints": [], "category": "restaurant",
    }


def _changes(turn: str) -> list:
    result = M.merge_turn(_base_intent(), turn)
    return result.changes


def test_the_canonical_table_holds_both_spellings_of_every_cue():
    # Every pair is a Simplified form and its Traditional form - never the same
    # character twice, and never the other way round.
    for simplified, traditional in CANONICAL_FORMS.items():
        assert simplified != traditional, (
            f"U+{ord(simplified):04X} is mapped to itself")
        assert canonical(simplified) == traditional
        assert canonical(traditional) == traditional, (
            f"U+{ord(traditional):04X} is not a fixed point of the canonicalisation")


def test_every_merge_cue_answers_to_both_spellings():
    """Each cue, in the spelling the vocabulary holds and in the other one, does the same."""
    checked = 0
    for name in dir(M):
        if not name.endswith("_CUES"):
            continue
        cues = getattr(M, name)
        if not isinstance(cues, tuple):
            continue
        for cue in cues:
            if not isinstance(cue, str) or not cue.strip():
                continue
            other = _other_spelling(cue)
            if other == cue:
                continue  # a cue with no other spelling (English, or a shared character)
            assert canonical(cue) == canonical(other), (
                f"{name}: the cue and its other spelling do not meet: "
                f"{cue.encode('unicode_escape').decode()} vs "
                f"{other.encode('unicode_escape').decode()}")
            checked += 1
    assert checked, "no merge cue with two spellings was checked - the property is untested"


def test_the_refinement_cue_is_two_words_and_not_one():
    # The guard the D433 test needed and did not have. The cue list holds the CANONICAL
    # form, and D421's canonicalisation keeps a list's shape - so the same word can sit in
    # it twice. That is by design; what is NOT by design is reading "the two spellings"
    # out of it: the two spellings come from the canonical table, and they must differ.
    assert M.CHEAPER_CUES[0] == canonical(M.CHEAPER_CUES[0]), (
        "the cue list does not hold the canonical form")
    assert _other_spelling(M.CHEAPER_CUES[0]) != M.CHEAPER_CUES[0], (
        "the cue has no other spelling - the canonical table does not hold both")
    assert _other_spelling(M.NEARER_CUES[1]) != M.NEARER_CUES[1], (
        "the cue has no other spelling - the canonical table does not hold both")


def test_the_cheaper_refinement_fires_in_both_spellings():
    canonical_cue = M.CHEAPER_CUES[0]
    other = _other_spelling(canonical_cue)
    assert other != canonical_cue
    assert _changes(canonical_cue), "the canonical spelling did not refine anything"
    assert _changes(other) == _changes(canonical_cue), (
        "the other spelling of the refinement did not do the same thing")
