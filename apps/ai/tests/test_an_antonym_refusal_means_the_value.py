"""D570 - refusing a value's OPPOSITE asks FOR the value, not against it.

The quiet rule carries 嘈 (noisy) because a QUESTION about it asks whether the place is noisy
(有無嘈, D533) and the preference stays +1. But a REFUSAL of it - "唔好嘈" (don't be noisy) - was
read as a refusal of QUIET, so the ranking lane was told to demote the quiet merchants. Measured on
the live corpus: `quiet_ambience` is true on **188 of 470** published merchants, so the inversion
reached 40% of the plane.

`polarity_for` is the pure cue reader and still answers -1 for "唔好咁嘈" / "嘈" (its own tests pin
that). The inversion lives in `apply_polarity`, which knows the preference's (key, value) and reads
`lexicon.ANTONYM_TERMS`.

Pure and DB-free.
"""

from __future__ import annotations

import nexus_ai.nlu.lexicon as L
from nexus_ai.nlu.polarity import apply_polarity, polarity_for
from nexus_ai.nlu.understand import extract_intent


def _quiet_polarity(text: str) -> int | None:
    for p in extract_intent(text).preferences:
        if (p.get("key"), p.get("value")) == ("ambience", "quiet"):
            return int(p.get("polarity", 0))
    return None


class TestTheExtractor:
    def test_a_refusal_of_noise_wants_quiet(self):
        assert _quiet_polarity("唔好嘈") == 1

    def test_the_control_a_refusal_of_quiet_still_negates_it(self):
        assert _quiet_polarity("唔好安靜") == -1

    def test_a_question_about_noise_still_wants_quiet(self):
        assert _quiet_polarity("有無嘈") == 1

    def test_the_phrase_that_says_it_outright(self):
        assert _quiet_polarity("唔想太嘈") == 1

    def test_the_constraint_lane_is_unaffected(self):
        keys = {(c.get("key"), c.get("value")) for c in extract_intent("唔好嘈").constraints}
        assert ("noise_avoid", "noise") in keys


class TestTheLayersAreSeparate:
    def test_the_pure_reader_still_answers_the_cue(self):
        # polarity_for is a cue reader, not a preference writer; its -1 is what its tests pin.
        assert polarity_for("唔好咁嘈", "嘈") == -1

    def test_apply_polarity_inverts_the_antonym(self):
        out = apply_polarity([{"key": "ambience", "value": "quiet", "polarity": 1}],
                             "唔好嘈", {("ambience", "quiet"): "嘈"})
        assert out[0]["polarity"] == 1

    def test_the_antonym_table_names_noise_for_quiet(self):
        assert L.ANTONYM_TERMS[("ambience", "quiet")] == frozenset({"嘈"})
