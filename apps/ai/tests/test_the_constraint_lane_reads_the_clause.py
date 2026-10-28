"""D536 - the constraint lane reads the clause, not eight characters.

The lane that writes the §7.1 constraints had its own idea of how far a refusal
reaches: eight characters past the negation, measured from the end of the cue AFTER
its trailing space was stripped - so a value had seven characters of room. Two holes
fell out of that, one per half of the rule:

    no cilantro    ->  []        the value is eight characters: the window cut it
    no coriander   ->  []        nine
    don't want spicy          -> []   one verb and two spaces sat in the window
    I do not want spicy food  -> []
    唔要咖喱        ->  []       咖喱 is in CONSTRAINT_CANON and in no rule's values

The last is the value list's hole, not the window's: a form the product's own canon
names that no rule carries can never be read, however far the window reaches.

Widening the window was measured, and the widening is what this unit refuses: at
sixteen characters "no rush want spicy" reads as a refusal of the spicy, because both
clauses' words sit inside it. So the window is not a grammar, it is a guess at one -
and this unit replaces it with the rule the polarity lane already reads a refusal by
(D535): the cue governs a value in its own clause, and one verb may bridge the two.

Both directions were then measured against HEAD's own matcher over the sentences the
product's refusal tests speak: every sentence the window wrote a constraint for the
clause rule writes the same one, and no sentence loses a read - while a body of
sentences the window never reached now reads. The count is not restated here because
the corpus it is measured over is this package's own test files, so the figure moves
when a refusal is added; `READ_AT_HEAD` below is that population, curated to span every
rule key, and it is the durable witness.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.lexicon import CONSTRAINT_CANON, CONSTRAINT_RULES, canon_constraint
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: the refusals the lane could not read, measured before this unit, each with the ONE
#: constraint the sentence must write.
UNREADABLE = (
    ("no cilantro", ("diet_avoid", "coriander")),
    ("no coriander", ("diet_avoid", "coriander")),
    ("唔要咖喱", ("cuisine_avoid", "curry")),
    ("唔要咖哩", ("cuisine_avoid", "curry")),
    ("don't want spicy", ("cuisine_avoid", "spicy")),
    ("I do not want spicy food", ("cuisine_avoid", "spicy")),
    ("avoid coriander", ("diet_avoid", "coriander")),
    ("without cilantro", ("diet_avoid", "coriander")),
)

#: what the widened window read as a refusal of the spicy. The normaliser turns the
#: clause comma into a space, so the comma'd spelling is pinned beside the bare one.
NOT_REFUSALS = (
    ("no rush want spicy",),
    ("no rush, want spicy",),
)

#: The key each canon value belongs to. The test owns this map on purpose: it is the
#: semantic contract - a curry is a cuisine the user refuses, a coriander is a diet
#: fact - and a census that read the rule table back to itself could not tell a value
#: that drifted into the wrong rule from one that never moved.
KEY_OF = {
    "spicy": "cuisine_avoid",
    "curry": "cuisine_avoid",
    # D584 gave every cuisine the ASK lane names a refusal surface, and the surfaces enter
    # the canon - the 10 values below are what that wrote here. Declared by what the fact IS,
    # not read off the rule table: a user who refuses 素食 refuses a cuisine the corpus tags,
    # which is the lane that filters. 素食's own value was already declared by someone else's
    # sentence, so it is not among these.
    "cantonese": "cuisine_avoid",
    "dim_sum": "cuisine_avoid",
    "indian": "cuisine_avoid",
    "italian": "cuisine_avoid",
    "japanese": "cuisine_avoid",
    "korean": "cuisine_avoid",
    "malaysian": "cuisine_avoid",
    "thai": "cuisine_avoid",
    "vegetarian": "cuisine_avoid",
    "western": "cuisine_avoid",
    "pork": "diet_avoid",
    "beef": "diet_avoid",
    "seafood": "diet_avoid",
    "coriander": "diet_avoid",
    "peanut": "diet_avoid",
    "onion": "diet_avoid",
    "garlic": "diet_avoid",
    "dairy": "diet_avoid",
    "gluten": "diet_avoid",
    "smoking": "smoking_avoid",
    "queue": "feature_avoid",
    "noise": "noise_avoid",
    "ginger": "diet_avoid",
}

#: the two cues a refusal is read under - the Cantonese spelling and the English one.
CUES = ("唔要", "no ")


def _carrying_rule(surface: str) -> str:
    """The key of the rule whose values carry `surface`, read off the table itself."""
    text = canonical(surface)
    low = text.lower()
    for key, _negs, values in CONSTRAINT_RULES:
        if any(cue_in(v.strip(), text, low) for v in values):
            return key
    return ""


def got_constraints(ex) -> set[tuple[str, str]]:
    """The (key, value) pairs the lane wrote, as one comparable set."""
    return {(c["key"], c["value"]) for c in ex.constraints}


@pytest.mark.parametrize("surface", sorted(CONSTRAINT_CANON), ids=sorted(CONSTRAINT_CANON))
def test_the_canon_names_a_form_a_rule_carries(surface):
    """A surface form the product's own canon names must sit in some rule's values."""
    assert _carrying_rule(surface), (
        f"CONSTRAINT_CANON names {surface!r} and no constraint rule carries it - a "
        f"user who refuses it gets no constraint at all")


@pytest.mark.parametrize("surface", sorted(CONSTRAINT_CANON), ids=sorted(CONSTRAINT_CANON))
def test_the_surface_form_is_read_as_its_canon_value(surface):
    """Refuse the surface form, under both cues, and the canon's value is written."""
    want = canon_constraint(surface)
    for cue in CUES:
        got = got_constraints(extract_intent(f"{cue}{surface}"))
        assert (KEY_OF[want], want) in got, (
            f"{cue + surface!r} wrote {sorted(got) or 'nothing'} - the canon reads the "
            f"word as {want!r}, a {KEY_OF[want]} fact, and no rule wrote it")


def test_the_contract_covers_every_value_the_canon_names():
    """A new canon entry must declare which lane its fact belongs to."""
    undeclared = sorted(set(CONSTRAINT_CANON.values()) - set(KEY_OF))
    assert not undeclared, (
        f"the canon names values no key is declared for: {undeclared} - add each to "
        f"KEY_OF with the lane its fact belongs to")


@pytest.mark.parametrize("text,want", UNREADABLE, ids=[t for t, _w in UNREADABLE])
def test_the_refusals_the_lane_could_not_read(text, want):
    """The measured holes, held closed: the sentence writes exactly its one refusal."""
    got = got_constraints(extract_intent(text))
    assert got == {want}, (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the constraint it names is {want}")


@pytest.mark.parametrize("text", [t[0] for t in NOT_REFUSALS],
                         ids=[t[0] for t in NOT_REFUSALS])
def test_a_value_in_another_clause_is_not_refused(text):
    """A window that reaches across the clause reads a refusal the user never made."""
    ex = extract_intent(text)
    assert ex.constraints == [], (
        f"{text!r} wrote {sorted(got_constraints(ex)) or 'nothing'} - the value sits in "
        f"the clause AFTER the refusal's own, and a reach that long is not a clause")


#: Every sentence the eight-character window DID read, out of the ones the product's own
#: refusal tests speak, curated to span all five rule keys and each gap shape the clause
#: rule keeps: bare, filler (咁 / the), one verb (食 / want), a conjunction ending the
#: first clause, and the question's 有 that governs nothing (D533). The rule change is
#: allowed to gain reach, never to lose a refusal the lane used to write.
READ_AT_HEAD = (
    ("唔好食辣", {("cuisine_avoid", "spicy")}),
    ("我唔食辣", {("cuisine_avoid", "spicy")}),
    ("唔好辣，想找個安靜的咖啡店", {("cuisine_avoid", "spicy")}),
    ("唔好咁嘈", {("noise_avoid", "noise")}),  # D545: the canon spells the value now
    ("唔食香菜", {("diet_avoid", "coriander")}),
    ("不要蔥蒜", {("diet_avoid", "garlic"), ("diet_avoid", "onion")}),
    ("沒有海鮮", {("diet_avoid", "seafood")}),
    ("唔想排隊", {("feature_avoid", "queue")}),
    ("no queue please", {("feature_avoid", "queue")}),
    ("without dairy", {("diet_avoid", "dairy")}),
    ("no gluten, thanks", {("diet_avoid", "gluten")}),
    ("no ginger in it", {("diet_avoid", "ginger")}),
    ("avoid smoking area", {("smoking_avoid", "smoking")}),
    ("not spicy please", {("cuisine_avoid", "spicy")}),
    ("no pork and no beef", {("diet_avoid", "pork"), ("diet_avoid", "beef")}),
    ("cheap and no curry", {("cuisine_avoid", "curry")}),
    ("有冇辣？冇海鮮", {("diet_avoid", "seafood")}),
    # D535's rule, inherited by this lane: a conjunction ends the clause, so only the
    # first member of a coordinated object is refused. Filed as this unit's residue.
    ("without onion or garlic", {("diet_avoid", "onion")}),
    ("avoid peanuts and tree nuts", {("diet_avoid", "peanut")}),
)


@pytest.mark.parametrize("text,want", READ_AT_HEAD, ids=[t for t, _w in READ_AT_HEAD])
def test_no_refusal_the_window_read_is_lost(text, want):
    """The clause rule writes every constraint HEAD's eight-character window wrote."""
    got = got_constraints(extract_intent(text))
    assert want <= got, (
        f"{text!r} wrote {sorted(got) or 'nothing'} but the window read {sorted(want)} - "
        f"reach is allowed to change shape, a refusal already written is not")
