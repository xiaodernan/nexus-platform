"""D543 - the eat-less refusal puts the verb AFTER the cue, and the clause rule must read it.

D537 taught the after-case that a cue with words after it is speaking about THOSE words:
"I want spicy no cilantro" answered spicy -1, because the "no" governs the cilantro that
follows it. The rule that came out of it - a cue reaches back only when it governs nothing
after it - is right for a NOUN and wrong for a VERB, because the eat-less refusal is
written the other way round:

    花生少吃       peanut, eat less        ->  diet_avoid:peanut
    peanut 別吃    peanut, do not eat      ->  diet_avoid:peanut
    gluten 避免吃   gluten, avoid eating    ->  diet_avoid:gluten

The value sits BEFORE the cue and the verb sits after it; the verb's object is the value.
Measured at HEAD, every one of these wrote nothing and answered `unknown` - the user
refused and the product heard nothing, in the language most of its users type.

The rule this unit writes: the tail after the cue may be ONE bridge verb (with the clause's
own particles hanging off it), because then the cue governs the verb and the verb's object
is the token the backward arm already found. A NOUN after the cue is still the cue's own
object (D537), and a verb with an object of its own after it is the forward refusal of that
object - both stay unread in the backward direction.

The door walks the product's own tables: every surface the constraint rules name, every
negation they read, every verb the bridge carries. Each row charges the constraint lane,
and the shared negations charge the polarity lane too, because a refusal one lane writes
and the other does not read is the D493 debt - pinned at the new shape here, not fixed
here.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical, canonical_node
from nexus_ai.nlu.lexicon import CONSTRAINT_RULES, canon_constraint, normalize_query
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: Every negation, as the ONE matcher wants it - stripped of the trailing space a Latin
#: entry carries (D538), and canonicalised the way both tables are at import.
RULE_NEGATIONS = canonical_node(tuple(dict.fromkeys(
    n.strip() for _k, negs, _v in CONSTRAINT_RULES for n in negs)))
POLARITY_NEGATIONS = canonical_node(tuple(c.strip() for c in P.NEGATION_CUES))

#: the negations BOTH lanes read - the rows that may charge the polarity lane.
SHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c in POLARITY_NEGATIONS)

#: Every surface a constraint rule can name, the rule that carries it, and the canon value.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}
RULE_KEYS = tuple(k for k, _n, _v in CONSTRAINT_RULES)

#: the bridge verbs - the tail this unit teaches the clause rule to read.
VERBS = tuple(P._VERB_BRIDGE)

#: one surface per rule key, so the verb axis walks every refusal key too.
KEY_VALUES = tuple(next(v for v in VALUES if RULE_OF[v] == k) for k in RULE_KEYS)


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _eat_less(value: str, cue: str, verb: str, gap: str = "") -> str:
    """The refusal as a user writes it: the value first, the cue after it, the verb last.

    An English cue needs its space, a Chinese one does not, and the gap - nothing, or one
    space - goes between the value and the cue either way.
    """
    return f"{value}{gap} {cue} {verb}" if cue.isascii() else f"{value}{gap}{cue}{verb}"


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


#: the census: every surface the rules name, under every negation they read, with one
#: bridge verb after the cue. The verb axis walks every verb below; the value axis walks
#: every surface here.
ROWS = [(value, negation) for value in VALUES for negation in RULE_NEGATIONS]


@pytest.mark.parametrize("value,negation", ROWS, ids=[f"{v}|{c}" for v, c in ROWS])
def test_a_verb_after_the_cue_is_the_refusals_own_verb(value: str, negation: str) -> None:
    """The eat-less shape writes the rule's constraint - and the shared cues read as a dislike.

    A verb in the tail is not the cue's object: the cue governs the verb, and the verb's
    object is the value the backward arm found before the cue.
    """
    sentence = _prepare(_eat_less(value, negation, "食"))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_eat_less(value, negation, '食')!r} wrote {sorted(_written(ex)) or 'nothing'} - "
        f"the cue is followed by a verb and the reader took the verb for the cue's object")

    if negation not in POLARITY_NEGATIONS:
        return  # the D493 debt: pinned below, at this very shape
    low = sentence.lower()
    for surface in VALUES:
        if cue_in(surface, sentence, low):
            sign = P.polarity_for(sentence, surface)
            assert sign == -1, (
                f"{sentence!r}: the constraint lane refused {surface!r} and the polarity "
                f"lane read it {sign:+d} - the two lanes disagree about one sentence")


#: the verb axis: every negation the rules read x every verb the bridge carries, with the
#: surface walking the five rule keys so every refusal key is charged too.
VERB_ROWS = [(negation, verb, KEY_VALUES[i % len(KEY_VALUES)])
             for i, negation in enumerate(RULE_NEGATIONS) for verb in VERBS]


@pytest.mark.parametrize("negation,verb,value", VERB_ROWS,
                         ids=[f"{c}|{v}|{s}" for c, v, s in VERB_ROWS])
def test_every_bridge_verb_arms_the_tail(negation: str, verb: str, value: str) -> None:
    """Any verb the bridge names works as the cue's tail, in either script."""
    sentence = _prepare(_eat_less(value, negation, verb))
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(extract_intent(sentence)), (
        f"{_eat_less(value, negation, verb)!r} wrote "
        f"{sorted(_written(extract_intent(sentence))) or 'nothing'} - the verb {verb!r} did "
        f"not arm the tail after the cue")


#: the shapes a user actually writes the eat-less refusal in.
SHAPES = (
    ("花生 少吃", {("diet_avoid", "peanut")}),
    ("花生少吃呀", {("diet_avoid", "peanut")}),
    ("peanut 別吃", {("diet_avoid", "peanut")}),
    ("peanut no eat", {("diet_avoid", "peanut")}),
    ("花生 no eat", {("diet_avoid", "peanut")}),
    ("gluten 避免吃", {("diet_avoid", "gluten")}),
    ("牛肉 唔好食", {("diet_avoid", "beef")}),
    ("辣 少吃", {("cuisine_avoid", "spicy")}),
    ("spicy 唔好食", {("cuisine_avoid", "spicy")}),
)


@pytest.mark.parametrize("text,want", SHAPES, ids=[t for t, _w in SHAPES])
def test_the_eat_less_shapes_read_in_both_scripts(text: str, want) -> None:
    """The spaced, the particled and the mixed-script spellings of the same refusal."""
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads {sorted(want)}")


#: what the verb tail must NOT become. A noun after the cue is still the cue's object; a
#: verb with an object of its own is the forward refusal of that object; a clause boundary
#: still ends the value's clause; and the existential question is still a question.
NOT_READ = (
    ("I want spicy no cilantro", {("diet_avoid", "coriander")}),
    ("辣唔好咖喱", {("cuisine_avoid", "curry")}),
    ("辣唔好食咖喱", {("cuisine_avoid", "curry")}),
    ("辣，唔好食", set()),
    ("花生有冇食", set()),
    ("咖喱有冇食", set()),
)


@pytest.mark.parametrize("text,want", NOT_READ, ids=[t for t, _w in NOT_READ])
def test_the_verb_tail_does_not_open_the_backward_arm(text: str, want) -> None:
    """The tail is ONE verb and nothing else - the older rules keep their teeth.

    D537's inversion, D538's boundary, D539's separator and D533's question all still
    hold with a verb at the end of the clause.
    """
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads {sorted(want)}")


#: the D493 debt at the new shape: the four negations only the constraint table reads
#: write the refusal while the polarity lane still boosts the value.
DEBT = (
    ("海鲜 少吃", "海鮮"),
    ("辣 避免食", "辣"),
    ("peanut 別食", "peanut"),
    ("gluten 不吃食", "gluten"),
)


@pytest.mark.parametrize("text,surface", DEBT, ids=[t for t, _s in DEBT])
def test_the_debt_is_measured_at_the_new_shape_too(text: str, surface: str) -> None:
    """The shared reader made the split measurable here as well - the debt is not fixed.

    The constraint lane refuses; the polarity lane, whose table does not carry these
    four words, reads the value as wanted. The debt gate next door holds the pin; this
    row keeps the new shape inside its reach.
    """
    sentence = _prepare(text)
    ex = extract_intent(sentence)
    assert _written(ex), f"{text!r} wrote no refusal at all - the cue stopped reading"
    sign = P.polarity_for(sentence, surface)
    assert sign == 1, (
        f"{text!r}: the polarity lane reads {sign:+d} - if the four negations joined "
        f"NEGATION_CUES this row would redden on purpose; update the debt pin, do not "
        f"delete this row")


def test_the_census_population_is_real():
    """A door that walks nothing agrees vacuously."""
    assert VALUES and RULE_NEGATIONS and VERBS, (
        "the rules carry no surface, or no negation, or no bridge verb - the rows above "
        "are empty and their green means nothing")
    keys = {RULE_OF[v] for v in VALUES}
    assert not set(RULE_KEYS) - keys, (
        f"the census walks no value for {sorted(set(RULE_KEYS) - keys)} - that rule's "
        "eat-less shape is untested")
    walked = {RULE_OF[v] for _n, _v, v in VERB_ROWS}
    assert not set(RULE_KEYS) - walked, (
        f"the verb axis walks no value for {sorted(set(RULE_KEYS) - walked)} - that "
        "rule's verbs are untested")
