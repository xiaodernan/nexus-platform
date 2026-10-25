"""Contract tests for the clause-final negation rule (``nlu/polarity.clause_final``, D537/D538/D543).

A negation cue governs a PRECEDING token only when it governs nothing after it:
- a cue with its own object after it speaks about THAT object ("no cilantro" keeps the cilantro);
- the tail is the cue's OWN CLAUSE, so a comma ends the refusal's reach;
- ONE bridge verb may follow the cue ("花生少吃", "gluten 避免吃") — its object is the token before
  the cue — but a verb with an object of its own ("唔好食咖喱") is the forward refusal of that object.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.nlu.polarity as P


def _final(text: str, cue: str) -> bool:
    low = text.lower()
    return P.clause_final(low, low.find(cue), cue)


class TestClauseFinal:
    def test_nothing_follows_the_cue(self):
        assert _final("素食唔好", "唔好") is True

    def test_only_a_particle_follows(self):
        assert _final("辣唔好呀", "唔好") is True

    def test_a_comma_ends_the_cues_clause(self):
        # "安靜的不好，要嘈" refuses 安靜 and asks for 嘈; the comma ends the refusal's reach
        assert _final("辣唔好，要嘈", "唔好") is True

    def test_one_bridge_verb_may_follow(self):
        assert _final("花生少吃", "少") is True
        assert _final("gluten 避免吃", "避免") is True
        assert _final("peanut 別吃", "別") is True
        assert _final("唔好食", "唔好") is True

    def test_an_object_after_the_cue_is_not_final(self):
        # "I want spicy no cilantro": the "no" governs the cilantro, not the spicy
        assert _final("I want spicy no cilantro", "no") is False

    def test_a_verb_with_its_own_object_is_not_final(self):
        assert _final("唔好食咖喱", "唔好") is False

    def test_a_bare_cue_is_final(self):
        assert _final("no", "no") is True


class TestGovernedByVerb:
    def test_one_bridge_verb(self):
        assert P._governed_by_verb("吃") is True
        assert P._governed_by_verb("eat") is True

    def test_verb_with_an_object_is_false(self):
        assert P._governed_by_verb("eat something") is False
        assert P._governed_by_verb("食咖喱") is False
        assert P._governed_by_verb("want it") is False

    def test_non_verbs_are_false(self):
        assert P._governed_by_verb("") is False
        assert P._governed_by_verb("呀") is False
        assert P._governed_by_verb("的") is False


class TestConstants:
    def test_clause_boundary_characters(self):
        assert P._CLAUSE_BOUNDARY_CHARS == ",，。;；!?！？"

    def test_verb_bridge_vocabulary(self):
        assert P._VERB_BRIDGE == ("want", "like", "eat", "have",
                                  "要", "想", "食", "吃", "鍾意", "喜歡")
