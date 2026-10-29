"""D355 — query-understanding lexicon contract (spec §7, §12, §111-112).

Pins the deterministic, DB-free lexicon that the NLU extractors build on:

* locale detection (AGENT_CONTRACT §12) — zh-HK (traditional, market default) vs
  zh-CN (simplified) vs en, decided by explicit trad/simp marker pairs so a *shared*
  character (餐/吃/情) can never vote for the wrong locale.
* district / category / cuisine matching — deterministic substring + rightmost/longest
  tie-break; generic buckets (restaurant/retail/attraction) carry a *lower* confidence
  so the model never over-claims.
* query normalization, constraint canonicalization, quoted-entity and proper-noun
  extraction.

Everything here is pure data + pure functions; no network, no DB. Each test asserts the
*actual* behaviour observed by probing the module, so a future refactor that silently
changes a rule is caught. Where the behaviour diverges from the module docstring, the
test comment + STATUS §351 note it rather than "fixing" code on a guess.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L


# --------------------------------------------------------------------------- §12 locale
class TestLocaleDetection:
    def test_empty_is_zh_hk_default(self):
        assert L.detect_language("") == "zh-HK"

    def test_pure_ascii_is_en(self):
        assert L.detect_language("find a restaurant nearby") == "en"

    def test_traditional_detected_zh_hk(self):
        # 廳 is a traditional marker (廳/厅 pair)
        assert L.detect_language("餐廳") == "zh-HK"

    def test_simplified_detected_zh_cn(self):
        # 厅 is the simplified marker of the same pair
        assert L.detect_language("餐厅") == "zh-CN"

    def test_trad_marker_zh_hk(self):
        assert L.detect_language("銅鑼灣") == "zh-HK"

    def test_simp_marker_zh_cn(self):
        # 电 (電/电) and 脑 (腦/脑) are the simplified markers of their pairs
        assert L.detect_language("电脑") == "zh-CN"

    def test_shared_char_does_not_vote(self):
        # 餐 appears in *both* zh-HK and zh-CN synonym lists but is NOT a marker, so it
        # must never push the locale either way — market default wins.
        assert L.detect_language("餐") == "zh-HK"
        assert L.detect_language("餐飯") == "zh-HK"


# --------------------------------------------------------------------------- district
class TestDistrictMatching:
    def test_match_by_zh_alias(self):
        name, spec = L.match_district("尖沙咀食飯")
        assert name == "Tsim Sha Tsui"

    def test_match_by_en_name(self):
        name, spec = L.match_district("central")
        assert name == "Central"

    def test_longest_alias_wins(self):
        # both "causeway bay" (len 13) and "cwb" (len 3) match; the longer alias wins
        name, _ = L.match_district("causeway bay cwb")
        assert name == "Causeway Bay"

    def test_none_for_non_hk_text(self):
        assert L.match_district("搵食好餐廳") is None

    def test_returned_spec_schema(self):
        _, spec = L.match_district("中環")
        assert set(spec.keys()) >= {"aliases", "lat", "lng", "area"}
        assert isinstance(spec["lat"], float)
        assert isinstance(spec["lng"], float)
        assert isinstance(spec["aliases"], list) and spec["aliases"]


# --------------------------------------------------------------------------- category
class TestCategoryMatching:
    def test_restaurant_generic_low_confidence(self):
        cat, conf = L.match_category("餐廳")
        assert cat == "restaurant"
        assert conf == 0.7  # generic bucket, short hit -> never over-claim

    def test_cafe_specific_full_confidence(self):
        cat, conf = L.match_category("咖啡店")
        assert cat == "cafe"
        assert conf == 0.95

    def test_the_traditional_word_for_restaurant_is_recognised(self):
        # D414: the word a Hong Kong user types is 餐廳 - U+9910 U+5EF3, and U+5EF3 IS
        # 廳 (the Unihan database: "U+5EF3 = the hall"). D409 asserted the opposite,
        # because its own probe spelled the word with U+5EF6, which is 延 (to delay) -
        # so the case measured the probe, not the product.
        cat, conf = L.match_category("\u9910\u5ef3")
        assert cat == "restaurant"
        assert conf == 0.7  # the generic bucket still does not over-claim

    def test_the_tea_restaurant_word_is_recognised(self):
        cat, conf = L.match_category("\u8336\u9910\u5ef3")
        assert cat == "cafe"
        assert conf == 0.95

    def test_a_word_with_the_wrong_code_point_matches_nothing(self):
        # The guard against the typo coming back, in the direction the truth is:
        # U+5EF6 is 延, so 餐延 is not a restaurant - it is the restaurant word
        # followed by the character for "to delay", and the vocabulary must not answer
        # for it. A synonym nobody types costs nothing; a MISSING synonym costs the
        # whole category.
        assert L.match_category("\u9910\u5ef6") is None

    def test_rightmost_specific_wins(self):
        # 電影院 (cinema) precedes 咖啡店 (cafe); rightmost specific wins
        cat, _ = L.match_category("電影院同咖啡店")
        assert cat == "cafe"

    def test_rightmost_specific_wins_reversed(self):
        cat, _ = L.match_category("咖啡店同戲院")
        assert cat == "cinema"

    def test_none_when_no_signal(self):
        assert L.match_category("你好早晨") is None

    def test_retail_generic_low_confidence(self):
        cat, conf = L.match_category("商店")
        assert cat == "retail"
        assert conf == 0.7

    def test_the_possessive_marks_the_head(self):
        # D603 answered the question §351 flagged. A specific word still beats a generic one
        # in a compound (寵物美容 is a pet groomer), but 的/嘅 introduces the noun the sentence
        # is ABOUT: 可帶寵物的餐廳 is a restaurant that allows pets. Measured before the fix,
        # this sentence produced `category=pet` and the search answered with ten pet groomers.
        cat, _conf = L.match_category("可帶寵物的餐廳")
        assert cat == "restaurant"
        # the rule is about the POSSESSIVE, not about demoting every specific word: in a
        # compound the head is still the last word, so 寵物美容 is a beauty salon whose
        # modifier is 寵物, and 寵物餐廳 keeps the specific word as the category (unchanged).
        assert L.match_category("寵物美容")[0] == "beauty"
        assert L.match_category("寵物餐廳")[0] == "pet"


# --------------------------------------------------------------------------- cuisine
class TestCuisineMatching:
    def test_japanese(self):
        assert L.match_cuisines("我想食壽司") == ["japanese"]

    def test_thai(self):
        assert L.match_cuisines("泰國菜好食") == ["thai"]

    def test_vegetarian(self):
        assert L.match_cuisines("素食餐廳") == ["vegetarian"]

    def test_empty_when_no_signal(self):
        assert L.match_cuisines("你好") == []


# --------------------------------------------------------------------------- normalization
class TestQueryNormalization:
    def test_strips_punctuation_and_collapses_ws(self):
        # D538: the clause punctuation becomes the clause separator, not a space
        assert L.normalize_query("  你好，世界！  ") == "你好\u3000世界"

    def test_keeps_clock_colon(self):
        # colon between digits is a clock time, not punctuation
        assert L.normalize_query("7:30pm") == "7:30pm"

    def test_drops_non_digit_adjacent_colon(self):
        # colon NOT adjacent to any digit is dropped
        assert L.normalize_query("價錢：餐廳") == "價錢 餐廳"

    def test_drops_period(self):
        # D538: same - the separator, not a space, so the clause edge survives
        assert L.normalize_query("a.b") == "a\u3000b"

    def test_keeps_digits_and_cjk(self):
        # normalize_query does NOT lowercase — matching functions lower() internally
        assert L.normalize_query("ABC 123 中文") == "ABC 123 中文"


# --------------------------------------------------------------------------- constraints
class TestConstraintCanon:
    def test_spicy_zh(self):
        assert L.canon_constraint("辣") == "spicy"

    def test_spicy_en(self):
        assert L.canon_constraint("spicy") == "spicy"

    def test_curry_variants(self):
        assert L.canon_constraint("咖哩") == "curry"
        assert L.canon_constraint("咖喱") == "curry"

    def test_beef(self):
        assert L.canon_constraint("牛") == "beef"

    def test_queue(self):
        assert L.canon_constraint("排隊") == "queue"

    def test_unknown_lowercased(self):
        # The fallback needs a token NO table claims. `vegan` used to land here, and the cuisine
        # fold (`_add_cuisine_refusal_surfaces`) has since made it a known surface - so the row
        # moved to a word still outside the vocabulary rather than to a new expectation, because
        # what is under test is the fallback, not the table's size.
        assert L.canon_constraint("KETO") == "keto"

    def test_a_cuisine_surface_refuses_its_cuisine(self):
        # The fold's own purpose: the ask lane's spelling and the diet lane's word for one
        # cuisine answer ONE value, so 素食 / 純素 / vegetarian / vegan are the same refusal and
        # the plan's `avoid` list carries one fact, not four.
        for surface in ("素食", "純素", "vegetarian", "vegan"):
            assert L.canon_constraint(surface) == "vegetarian", surface
        # A Latin surface is stored under BOTH spellings, so the case the user typed is not the
        # case the table was written in: `BBQ` is the Korean list's surface, minuscule reads it.
        assert L.canon_constraint("bbq") == "korean"

    def test_a_dish_surface_refuses_its_whole_cuisine(self):
        # The cost the fold also buys, pinned with the number rather than left in a table a
        # reader cannot see: 拉麵 and 壽司 answer the SAME `japanese`, and
        # `categories.avoid_terms('japanese')` is ['japanese', 'sushi', 'ramen', 'izakaya'] - on
        # the live plane that refusal drops 28 tagged merchants where the taxonomy's own `ramen`
        # leaf would drop 12 of its 22 (`tmp/d615_avoid.txt`, 470 published merchants,
        # 2026-10-29). The corpus HAS the finer leaf, so refusing the dish as its cuisine is a
        # product decision, not a vocabulary limit.
        assert L.canon_constraint("拉麵") == "japanese"
        assert L.canon_constraint("壽司") == "japanese"

    def test_a_word_outside_the_refusal_vocabulary_refuses_nothing(self):
        # The other edge of the same table: 烤肉 - the Korean list's spelling - refuses `korean`,
        # while 燒烤, the ordinary word for the same food, is in no refusal row at all, so the
        # reader passes it through untouched and the plan filters nothing. One fact, two
        # outcomes, and the difference is only which list a hand happened to write.
        assert L.canon_constraint("烤肉") == "korean"
        assert L.canon_constraint("燒烤") == "燒烤"

    def test_a_simplified_surface_is_folded_upstream_not_here(self):
        # `understand.extract_intent` canonicalises the TEXT before any vocabulary comparison
        # (its `canonical(text)`, kept out of `normalize_query` by D420 so a Simplified user is
        # answered in their own script), and `CUISINE_TERMS` was itself canonicalised - which is
        # why a Simplified 点心 still reads as a dim-sum refusal end to end while this table holds
        # only the Traditional spelling. The bridge is in the reader, not here: a caller that
        # skips it gets the raw word back.
        assert L.canon_constraint("點心") == "dim_sum"
        assert L.canon_constraint("点心") == "点心"

    def test_a_one_character_surface_never_joins_a_refusal_row(self):
        # The fold's floor, pinned from the table side because no door pinned it from the matcher
        # side: 蟹 and 齋 are surfaces the ask lane names, and the moment either sits in a row the
        # refusal reader fires on the word it is the TAIL OF - `唔想食蟹黃飯` refuses seafood and
        # `唔想食長齋` refuses vegetarian (`tmp/d612_floor.py`, both measured by adding the two
        # characters to the rows in memory and asking the shipped `constraint_hits`). A CJK cue has
        # no word boundaries for the matcher to lean on, so a one-character surface is skipped on
        # the way in rather than trusted.
        bare = [s for _key, _negs, values in L.CONSTRAINT_RULES for s in map(str, values)]
        assert "蟹" not in bare and "齋" not in bare
        assert L.canon_constraint("蟹") == "蟹"
        assert L.canon_constraint("齋") == "齋"

    def test_none_yields_empty(self):
        assert L.canon_constraint(None) == ""


# --------------------------------------------------------------------------- entities
class TestEntityHints:
    def test_quoted_cjk(self):
        assert L.quoted_entities("我想去「海底撈」食飯") == ["海底撈"]

    def test_quoted_latin(self):
        assert L.quoted_entities('Book "Ocean Park" tickets') == ["Ocean Park"]

    def test_no_quotes(self):
        assert L.quoted_entities("沒有引號") == []

    def test_proper_nouns_captured(self):
        assert set(L.proper_nouns("Book a table at Starbucks")) == {"Book", "Starbucks"}

    def test_proper_nouns_stopwords_excluded(self):
        assert set(L.proper_nouns("Compare HKMovie and Apple")) == {"HKMovie", "Apple"}

    def test_proper_nouns_hk_excluded(self):
        assert L.proper_nouns("HK Disney resort") == ["Disney"]

    def test_proper_nouns_none(self):
        assert L.proper_nouns("hello there") == []


# --------------------------------------------------------------------------- data integrity
class TestLexiconDataIntegrity:
    def test_marker_sets_disjoint(self):
        # a character must never be a trad and simp marker at once
        assert L.SIMPLIFIED_MARKERS.isdisjoint(L.TRADITIONAL_MARKERS)

    def test_districts_well_formed(self):
        for name, spec in L.DISTRICTS.items():
            assert isinstance(name, str) and name
            assert spec["aliases"], f"{name} has no aliases"
            assert isinstance(spec["lat"], (int, float))
            assert isinstance(spec["lng"], (int, float))
            assert isinstance(spec["area"], str) and spec["area"]

    def test_preference_rule_values_derived(self):
        derived = [v for _k, v, _t, _p in L.PREFERENCE_RULES]
        assert derived == L.PREFERENCE_RULE_VALUES

    def test_preference_rules_shape(self):
        for row in L.PREFERENCE_RULES:
            assert isinstance(row, tuple) and len(row) == 4
            _key, _val, patterns, polarity = row
            assert isinstance(patterns, list) and patterns
            assert polarity in (1, -1)

    # D493: the lexicon's derived NEGATION_CUES is gone. It was derived from the
    # constraint rules and read by no production code - only by this test, which
    # re-derived it and so proved nothing - and the constraint rules now take the ONE
    # negations list (the polarity module's vocabulary), so the derived list would have
    # been the same list five times over. The polarity module holds the vocabulary.


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
