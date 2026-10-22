"""Contract tests for the cuisine vocabulary bridge (``nlu/lexicon``: `cuisine_leaves` /
`cuisine_matches`, D394).

The lexicon speaks the user's word ("japanese") while the seed stores the venue's taxonomy leaf
("sushi", "ramen", "izakaya"). Without the map a cuisine preference that IS satisfied never fires,
and a satisfied preference becomes indistinguishable from an unsatisfied one. The comparison is by
**leaf**, not by substring on a tag: a merchant whose tag merely contains the letters must not
match.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import pytest

import nexus_ai.nlu.lexicon as L


class TestCuisineLeaves:
    def test_known_cuisine_maps_to_its_seeded_leaves(self):
        assert L.cuisine_leaves("japanese") == ("sushi", "ramen", "izakaya")

    def test_case_and_whitespace_are_normalised(self):
        assert L.cuisine_leaves(" Japanese ") == ("sushi", "ramen", "izakaya")

    def test_dim_sum_maps_to_dimsum(self):
        assert L.cuisine_leaves("dim_sum") == ("dimsum",)

    def test_unknown_cuisine_is_matched_by_its_own_name(self):
        # a cuisine the taxonomy does not know is still a word a merchant may carry in its tags
        assert L.cuisine_leaves("unknown") == ("unknown",)

    def test_empty_and_none_have_no_leaves(self):
        assert L.cuisine_leaves("") == ()
        assert L.cuisine_leaves(None) == ()


class TestCuisineMatches:
    def test_tag_exact_match(self):
        assert L.cuisine_matches("japanese", "restaurant", ["sushi"]) is True

    def test_category_substring_match(self):
        # the category path is a containment check ("restaurant/sushi" carries the leaf)
        assert L.cuisine_matches("japanese", "restaurant/sushi", []) is True

    def test_tag_substring_does_not_match(self):
        # "sushibar" merely CONTAINS "sushi"; a leaf comparison must not fire
        assert L.cuisine_matches("japanese", "restaurant", ["sushibar"]) is False

    @pytest.mark.parametrize("tag", ["dimsum", "dim-sum", "DIM SUM"])
    def test_separators_and_case_are_one_word(self, tag):
        assert L.cuisine_matches("dim_sum", "restaurant", [tag]) is True

    def test_empty_cuisine_matches_nothing(self):
        assert L.cuisine_matches("", "restaurant", ["sushi"]) is False

    def test_no_category_or_tags_matches_nothing(self):
        assert L.cuisine_matches("japanese", "", []) is False

    def test_unknown_cuisine_matches_its_own_name(self):
        assert L.cuisine_matches("unknown", "restaurant", ["unknown"]) is True

    def test_category_containment_works_for_a_hyphenated_category(self):
        assert L.cuisine_matches("thai", "thai-food", []) is True
