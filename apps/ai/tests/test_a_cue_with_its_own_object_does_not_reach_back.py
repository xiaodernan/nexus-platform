"""D537 - a cue with an object of its own does not reach back to the token before it.

D533 taught the polarity lane to read a cue that sits AFTER the token it governs:
"素食唔好" refuses the 素食, "安靜的不好" refuses the 安靜. The rule was attachment
alone, and attachment is symmetric - an empty gap is the most attached gap there is.
So the lane read the cue backwards whenever it touched the token before it, and the
most natural way to refuse one thing while asking for another came back inverted:

    I want spicy no cilantro   ->  spicy -1     (a LIKE refused, a refusal unseen)

The "no" sits directly after "spicy" with nothing between them, so the after-case
fired; but the "no" governs the cilantro that follows it, and the ranking lane then
demoted the very cuisine the user asked for - the D522 shape, in the after-case.

The rule this unit writes: a cue governs a preceding token only when it governs
NOTHING after it. A cue that still has words after it is speaking about those words.
The Cantonese sentence-final particles (辣唔好呀 - spicy, no) are part of the refusal
and not words of their own, so they join the filler vocabulary; without them the new
rule would read "辣唔好呀" as a LIKE of the spicy, trading one defect for another.

The gate holds three things: the measured inversions are right-side up, the
after-cases the earlier units fixed still read -1, and the forward direction - the
one a user writes most often - is untouched.
"""

from __future__ import annotations

import unicodedata

import pytest

from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.lexicon import normalize_query
from nexus_ai.nlu.polarity import _LOCAL_FILLER, polarity_for
from nexus_ai.nlu.understand import extract_intent

#: the sentence-final particles, read off the product's own filler vocabulary - a
#: particle added to the table is covered by the gate the moment it exists.
PARTICLES = tuple(ch for ch in _LOCAL_FILLER.pattern
                  if unicodedata.category(ch) == "Lo")

#: the inversions measured before this unit, with the token each must now read +1 for.
#: The Cantonese one carries a clause comma, which the normaliser turns into a space -
#: the lane never sees it, so the gate must not either.
INVERTED = (
    ("I want spicy no cilantro", "spicy"),
    ("I want spicy no coriander", "spicy"),
    ("spicy food no cilantro", "spicy"),
    ("quiet, no noisy please", "quiet"),
    ("辣，唔要咖喱", "辣"),
)


def _read(query: str) -> str:
    """The text the polarity lane actually receives: normalised, then canonicalised."""
    return canonical(normalize_query(query))

#: the after-cases the earlier units fixed: the cue sits after the token, at the end
#: of its clause, and governs it.
PRESERVED = (
    ("素食唔好", "素食"),
    ("安靜的不好", "安靜"),
    ("辣唔好呀", "辣"),
    ("辣唔好㗎", "辣"),
)

#: the forward refusals, which this unit must not touch.
FORWARD = (
    ("no spicy", "spicy"),
    ("唔好食辣", "辣"),
    ("I do not want spicy food", "spicy"),
    ("don't want spicy", "spicy"),
    ("not too spicy", "spicy"),
)


def test_the_particles_the_unit_measured_are_in_the_table():
    """A gate whose cases come from a table that dropped them would pass forever."""
    for particle in ("呀", "㗎", "喎", "嘛", "囉", "嘞", "咩", "啩"):
        assert particle in PARTICLES, (
            f"{particle.encode('unicode_escape').decode()} is no longer in the filler "
            f"vocabulary - a Cantonese refusal written with it reads as a LIKE again")


@pytest.mark.parametrize("particle", PARTICLES, ids=PARTICLES)
def test_a_sentence_final_particle_keeps_the_after_case_alive(particle):
    """"辣唔好呀" refuses the 辣: the particle belongs to the refusal, not to an object."""
    read = _read(f"辣唔好{particle}")
    assert polarity_for(read, "辣") == -1, (
        f"辣唔好{particle} read the refusal as a LIKE - the particle is being read as "
        f"a word the cue governs after it")


@pytest.mark.parametrize("text,token", INVERTED, ids=[t for t, _k in INVERTED])
def test_a_cue_with_an_object_does_not_reach_back(text, token):
    """The measured inversions: the refusal belongs to what follows the cue."""
    read = _read(text)
    assert polarity_for(read, token) == 1, (
        f"{text!r} read {token!r} as {polarity_for(read, token)} - the cue governs the "
        f"object after it, and reading it backwards demoted the thing the user asked for")


def test_the_refusal_still_writes_its_own_constraint():
    """The behavioural half: the cilantro is still refused, and only the cilantro."""
    ex = extract_intent("I want spicy no cilantro")
    got = {(c["key"], c["value"]) for c in ex.constraints}
    assert got == {("diet_avoid", "coriander")}, (
        f"the sentence wrote {sorted(got) or 'nothing'} - the refusal of the coriander "
        f"must survive the fix, and the spicy must not become a constraint")
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(("cuisine", "spicy")) == 1, (
        f"the preference lane read the spicy as {prefs.get(('cuisine', 'spicy'))}")


@pytest.mark.parametrize("text,token", PRESERVED, ids=[t for t, _k in PRESERVED])
def test_the_after_cases_the_earlier_units_fixed_hold(text, token):
    """A cue at the end of its clause still governs the token before it."""
    read = _read(text)
    assert polarity_for(read, token) == -1, (
        f"{text!r} stopped reading the refusal of {token!r} - the clause-final rule ate "
        f"the after-case it was meant to bound")


@pytest.mark.parametrize("text,token", FORWARD, ids=[t for t, _k in FORWARD])
def test_the_forward_refusals_are_untouched(text, token):
    """The direction a user writes most often must not move."""
    read = _read(text)
    assert polarity_for(read, token) == -1, (
        f"{text!r} stopped reading the refusal of {token!r} - the new rule reached the "
        f"forward case it should never have touched")
