"""D582 - a WANT of a value's opposite is a DISLIKE of the value, and a bare mention is not.

The quiet row carries 嘈 (noisy) in its own token list, so a sentence that asks for the noise -
"嘈的餐廳" - matched the row and inherited its +1. `search/service.py` scores a merchant whose
`quiet_ambience` is True at 1.0 for a +1 preference and at 0.0 for a -1 one, so the ranking lane
was told the user wants a quiet restaurant and raised the quiet half of the plane over the loud
half the query asked for. Measured on the live plane, both before and after this rule:
`quiet_ambience` is true on **188** published merchants and false on **282**, and the query
"嘈的餐廳" scored them 1.0 / 0.0 before and 0.0 / 1.0 after.

D570 wrote the mirror image of this - a REFUSAL of the opposite wants the value ("唔好嘈").
This unit writes the other direction, and it cannot be one sign flip, because the same
character is written four ways and only one of them asks for anything:

    嘈的餐廳 / 我想嘈一點的餐廳   the query asks for it   ->  quiet -1  (the defect, fixed here)
    有冇嘈 / 有無嘈              a question about it     ->  quiet +1  (D533, pinned by D570)
    唔好嘈 / 唔想嘈             a refusal of it         ->  quiet +1  (D570)
    太嘈 / 唔太嘈 / 好嘈          a bare mention of it    ->  quiet +1  (no frame, no guess)

What separates the first row from the last is a FRAME, not a word: "好嘈" is what a user says
about a place they are leaving AND what they type when hunting for that kind of place, and the
second one has 的 or 嘅 or 想 after it. So `is_asked_for` reads the bridge verb in the surface's
own clause before it and the attributive particle in its clause after it, and a bare mention
keeps the row's own +1 - which is the behaviour the suite had before this unit, so nothing that
was right moved.

`polarity_for` is the pure cue reader and is unchanged: it still answers +1 for "嘈的餐廳",
which the second class below pins. The inversion is the composition in `antonym_direction` -
the one place that knows both the preference's (key, value) and the surface that matched it.
What a -1 preference then does to a ranking is `test_polarity_effect.py`'s, written by D393 for
the negated preference this shape reaches by the other road.

Pure and DB-free.
"""

from __future__ import annotations

import pytest

import nexus_ai.nlu.lexicon as L
from nexus_ai.nlu.matching import cue_positions
from nexus_ai.nlu.polarity import (NEGATION_CUES, antonym_direction, is_asked_about,
                                   is_asked_for, is_existential_question,
                                   negation_positions, polarity_for)
from nexus_ai.nlu.understand import constraint_hits, extract_intent

QUIET = ("ambience", "quiet")

#: The refusal the SAME sentence writes into the search plan, for the antonym pairs the
#: vocabulary carries. The both-lanes door compares the ranking's reading with the filter's,
#: and a pair with no entry here would be compared with nothing - so the floor below names it
#: instead of passing quietly.
CONSTRAINT_OF = {QUIET: ("noise_avoid", "noise")}


def _polarity(text: str, pair: tuple[str, str]) -> int | None:
    for pref in extract_intent(text).preferences:
        if (pref.get("key"), pref.get("value")) == pair:
            return int(pref.get("polarity", 0))
    return None


def _frames(term: str) -> list[tuple[str, int]]:
    """The four readings an antonym surface carries, in the shape of a query a user types.

    Built FROM the vocabulary instead of written beside it, so a second antonym term joins
    every walk below the moment it exists (D449: a table nothing reads is where the product's
    description of itself rots).
    """
    return [
        # a frame: the verb before it in its own clause, or the particle after it
        (f"{term}的餐廳", -1),
        (f"{term}嘅餐廳", -1),
        (f"特別{term}的餐廳", -1),
        (f"我想{term}一點的餐廳", -1),
        (f"我想要{term}一點嘅地方", -1),
        # the question (D533) and the refusal (D570) - the two that were right before
        (f"有冇{term}", 1),
        (f"有無{term}", 1),
        (f"有沒有{term}", 1),
        (f"有冇{term}的餐廳", 1),
        (f"唔好{term}", 1),
        (f"唔想{term}", 1),
        # a bare mention: no frame, no governance, no guess.
        # 嘈死 ("deafening") is the same shape and is NOT walked here - the reference gate
        # names a test that uses a character the product's vocabulary does not carry, and 死
        # is not in it, so this file cannot claim the product has heard the word.
        (f"太{term}", 1),
        (f"唔太{term}", 1),
        (f"好{term}", 1),
    ]


def _population() -> list[tuple[str, str, str, tuple[str, str], int]]:
    return [(f"{key}/{value}", term, text, (key, value), want)
            for (key, value), terms in sorted(L.ANTONYM_TERMS.items())
            for term in sorted(terms)
            for text, want in _frames(term)]


class TestTheWalkOfThePopulation:
    @pytest.mark.parametrize("label,term,text,pair,want", _population())
    def test_the_lane_reads_each_frame_of_an_antonym_one_way(self, label, term, text, pair,
                                                             want):
        assert _polarity(text, pair) == want, (label, term, text)

    def test_the_population_is_not_vacuous(self):
        # The parametrised rows above come from ANTONYM_TERMS; an empty table would leave this
        # file asserting nothing at all, and the gate that reddens is the one that knows.
        assert L.ANTONYM_TERMS, "the antonym vocabulary is empty, so the walk tests nothing"

    def test_every_pair_the_vocabulary_carries_has_a_constraint_to_be_compared_with(self):
        assert set(L.ANTONYM_TERMS) <= set(CONSTRAINT_OF), (
            "these antonym pairs name no refusal, so the both-lanes door below cannot see "
            "them: " + ", ".join(f"{k}/{v}" for k, v in sorted(set(L.ANTONYM_TERMS)
                                                                - set(CONSTRAINT_OF))))

    def test_every_antonym_term_is_a_surface_of_its_own_row(self):
        # The inversion fires on the SURFACE that matched, so a term in ANTONYM_TERMS that no
        # row carries is a table nothing reads - and the defect it was written for is back.
        rows = {(key, value): surfaces for key, value, surfaces, _p in L.PREFERENCE_RULES}
        for (key, value), terms in L.ANTONYM_TERMS.items():
            surfaces = rows.get((key, value))
            assert surfaces is not None, f"no preference row for {key}/{value}"
            for term in terms:
                assert term in surfaces, (
                    f"{term} is declared the opposite of {key}/{value} but the row does not "
                    f"carry it, so no sentence can reach the inversion")

    def test_no_antonym_term_is_its_own_value(self):
        for (key, value), terms in L.ANTONYM_TERMS.items():
            for term in terms:
                assert term.strip().lower() != value.strip().lower(), (
                    f"{term} is declared the opposite of {key}/{value} and is the value")


class TestThePureReaderIsUnmoved:
    def test_the_cue_reader_still_calls_the_want_a_want(self):
        # The -1 below is the composition's, not the reader's: `polarity_for` answers what the
        # sentence does to the surface, and nothing in "嘈的餐廳" negates the noise.
        assert polarity_for("嘈的餐廳", "嘈") == 1
        assert _polarity("嘈的餐廳", QUIET) == -1

    def test_the_cue_reader_still_answers_the_refusal(self):
        # D570's own pin: the pure reader is a cue reader, not a preference writer.
        assert polarity_for("唔好咁嘈", "嘈") == -1
        assert _polarity("唔好嘈", QUIET) == 1

    def test_a_token_that_is_not_in_the_sentence_is_not_turned_at_all(self):
        assert antonym_direction(0, "我想食粵菜", "嘈") == 0


class TestTheReadersOfTheSurface:
    def test_the_question_is_read_at_the_token(self):
        assert is_asked_about("有冇嘈", "嘈") is True
        assert is_asked_about("有無嘈", "嘈") is True
        assert is_asked_about("有沒有嘈", "嘈") is True

    def test_a_lead_that_is_not_under_a_有_is_not_a_question(self):
        # 冇 on its own refuses; the question is the 有 in front of it (D533).
        assert is_asked_about("冇嘈", "嘈") is False

    def test_the_two_arms_of_the_existential_lead_never_name_one_position(self):
        # D533's rule has two arms now, and they divide the positions of one cue between
        # them: a cue under a 有 is the question's verb, which `negation_positions` refuses
        # to call a refusal, and a token after it is the question's object, which
        # `is_asked_about` reads. One position cannot be both, or one sentence would be a
        # refusal and a question at once.
        for low in ("有冇嘈", "有無嘈", "有沒有嘈", "冇嘈", "有冇辣，冇海鮮", "唔好嘈"):
            for cue in NEGATION_CUES:
                c = cue.strip()
                if not c:
                    continue
                refused = set(negation_positions(c, low, low))
                leads = {at for at in cue_positions(c, low, low)
                         if is_existential_question(low, at)}
                assert not (refused & leads), f"{c} in {low}: both a refusal and a question"

    def test_the_frame_is_a_verb_before_or_a_particle_after(self):
        assert is_asked_for("嘈的餐廳", "嘈") is True
        assert is_asked_for("嘈嘅餐廳", "嘈") is True
        assert is_asked_for("我想嘈", "嘈") is True
        assert is_asked_for("我要嘈", "嘈") is True

    def test_a_bare_mention_carries_no_frame(self):
        # The complaint and the request are written with the same adjective, and nothing in
        # these five words says which - so the lane says neither and the row keeps its +1.
        for text in ("嘈", "太嘈", "唔太嘈", "好嘈", "咁嘈"):
            assert is_asked_for(text, "嘈") is False, text

    def test_a_verb_in_the_clause_before_is_not_the_surfaces_own(self):
        # The frame belongs to the clause, which is the unit D536 made governance: "我想食飯，
        # 嘈" asks for a meal and mentions the noise in the next breath.
        assert is_asked_for("我想食飯，嘈", "嘈") is False
        assert is_asked_for("嘈，我想食飯", "嘈") is False

    def test_the_frame_cannot_outvote_the_question(self):
        # 有冇嘈的餐廳 carries the particle AND the question's lead, and a user asking whether
        # a noisy place exists has not asked for one (D533).
        assert is_asked_for("有冇嘈的餐廳", "嘈") is True
        assert _polarity("有冇嘈的餐廳", QUIET) == 1

    def test_the_frame_cannot_outvote_the_refusal(self):
        # 唔想嘈 has the bridge verb in it and a refusal in front of it, and the refusal is
        # the sentence (D570).
        assert is_asked_for("唔想嘈", "嘈") is True
        assert _polarity("唔想嘈", QUIET) == 1

    def test_a_frame_is_not_a_refusal(self):
        # The two lanes ask different questions of the same words, and neither of them may
        # read the other's marker: the particle asks for a place, and 太 modifies a word.
        assert ("noise_avoid", "noise") not in constraint_hits("太嘈")
        assert ("noise_avoid", "noise") not in constraint_hits("嘈嘅餐廳")


class TestTheTwoLanesStillPointTheSameWay:
    @pytest.mark.parametrize("label,term,text,pair,want", _population())
    def test_a_refusal_the_plan_filters_for_is_never_a_want_of_the_value(
            self, label, term, text, pair, want):
        constraint = CONSTRAINT_OF[pair]
        filtered = constraint in constraint_hits(text)
        if want == -1:
            assert not filtered, f"{text}: the plan filters for what the ranking wants against"
        if filtered:
            assert want == 1, f"{text}: the plan refuses the noise the ranking calls a want"


class TestTheValueSurfacesAreNotTurned:
    def test_the_value_own_want_still_wants_it(self):
        # The inversion reads the OPPOSITE; a row's own value is untouched by it.
        assert _polarity("安靜的餐廳", QUIET) == 1

    def test_the_value_own_refusal_still_refuses_it(self):
        assert _polarity("唔好安靜", QUIET) == -1

    def test_the_arm_is_reached_only_from_the_declared_opposite(self):
        # `antonym_direction` turns whatever sign it is handed - the guard is the call site's,
        # and it is `ANTONYM_TERMS` that decides which surface the call asks about. 安靜 is not
        # in the table, so a row's own value never reaches the arm.
        assert "安靜" not in L.ANTONYM_TERMS.get(QUIET, frozenset())
        assert antonym_direction(1, "安靜的餐廳", "安靜") == -1
        assert _polarity("安靜的餐廳", QUIET) == 1
