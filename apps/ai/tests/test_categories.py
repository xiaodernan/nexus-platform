"""Contract tests for ``nexus_ai.search.categories.resolve`` (§111, taxonomy bridge).

This is the pure, DB-free bridge between the intent layer's coarse category *bucket*
(``restaurant``, ``escape_room``, ``retail`` …) and the seeded ``categories`` taxonomy
(10 roots + 67 leaves, hyphenated slugs). ``search/sql.py`` calls ``resolve`` to turn a
bucket into the set of slugs a SQL ``slug IN (…)`` predicate should match.

History (from STATUS / docs): comparing the raw bucket to the taxonomy slug with ``=``
matched *nothing* on the live DB — every categorised query returned an empty page — so
the bucket is expanded here into ``[bucket, slug(bucket), *ALIASES[bucket]]``. Pinning
the expansion is what stops that regression: an aliased bucket must still surface its
taxonomy slugs.

Discipline: every assertion below was confirmed against the running module (empirical
probe), never guessed. Where a real behavior surprised a naive premise, the premise was
corrected, not the code.
"""

import nexus_ai.search.categories as C


class TestEmptyInputs:
    def test_none_returns_empty(self):
        assert C.resolve(None) == []

    def test_empty_string_returns_empty(self):
        assert C.resolve("") == []

    def test_whitespace_only_returns_empty(self):
        # stripped to nothing -> treated as "no category asked"
        assert C.resolve("   ") == []
        assert C.resolve("\t\n  ") == []


class TestNormalization:
    def test_case_insensitive(self):
        assert C.resolve("RESTAURANT") == ["restaurant"]
        assert C.resolve("Restaurant") == ["restaurant"]

    def test_surrounding_whitespace_trimmed(self):
        assert C.resolve(" escape_room ") == ["escape_room", "escape-room"]


class TestSlugFormation:
    def test_underscore_becomes_hyphen(self):
        # every bucket carries its own name first, then the hyphenated taxonomy slug
        assert C.resolve("escape_room")[0] == "escape_room"
        assert "escape-room" in C.resolve("escape_room")

    def test_slug_present_even_for_unknown_bucket(self):
        # a never-seen bucket still yields a hyphenated slug form so a taxonomy
        # lookup has *something* to match against
        assert C.resolve("unknown_bucket") == ["unknown_bucket", "unknown-bucket"]

    def test_no_underscore_bucket_is_its_own_slug(self):
        assert C.resolve("retail") == ["retail", "shopping"]


class TestAliasExpansion:
    def test_afternoon_tea_multi_alias(self):
        out = C.resolve("afternoon_tea")
        assert out == ["afternoon_tea", "afternoon-tea", "tea-house", "cha-chan-teng"]

    def test_retail_alias(self):
        assert C.resolve("retail") == ["retail", "shopping"]

    def test_pet_alias(self):
        assert C.resolve("pet") == ["pet", "pet-grooming"]

    def test_attraction_alias(self):
        assert C.resolve("attraction") == ["attraction", "experience", "activity"]

    def test_yoga_alias(self):
        assert C.resolve("yoga") == ["yoga", "yoga-pilates"]

    def test_gym_alias(self):
        assert C.resolve("gym") == ["gym", "gym-club"]

    def test_bakery_alias(self):
        assert C.resolve("bakery") == ["bakery", "bakery-dessert"]

    def test_cooking_class_alias(self):
        assert C.resolve("cooking_class") == [
            "cooking_class",
            "cooking-class",
            "craft-workshop",
        ]


class TestDedupAndOrder:
    def test_order_stable_across_calls(self):
        a = C.resolve("afternoon_tea")
        b = C.resolve("afternoon_tea")
        assert a == b  # deterministic, order-stable

    def test_no_duplicate_slugs(self):
        # attraction's alias set contains 'activity', which is not the bucket nor a
        # hyphenation of it, so it appears exactly once
        out = C.resolve("attraction")
        assert len(out) == len(set(out))

    def test_bucket_is_first_element(self):
        # consumers key off the first element as the canonical coarse bucket
        for bucket in ("restaurant", "retail", "escape_room", "attraction"):
            assert C.resolve(bucket)[0] == bucket


class TestTaxonomyBridgeRegression:
    """The historical bug: bucket == slug matched nothing -> empty category page."""

    def test_aliased_bucket_surfaces_taxonomy_slugs(self):
        # the empty-page regression returns the instant this assertion would fail:
        # an aliased bucket MUST expose the taxonomy slugs it maps to
        assert set(C.resolve("afternoon_tea")) >= {"tea-house", "cha-chan-teng"}
        assert "shopping" in C.resolve("retail")
        assert "pet-grooming" in C.resolve("pet")

    def test_slug_form_always_present_for_sql_in(self):
        # sql.py does ``slug IN (resolve(bucket))`` — the hyphenated slug must be in
        # the returned set for any bucket that has a hyphenatable name
        assert "escape-room" in C.resolve("escape_room")
        assert "afternoon-tea" in C.resolve("afternoon_tea")

    def test_unknown_bucket_still_queryable(self):
        # even an unrecognised bucket yields a hyphenated slug, so a stray taxonomy
        # row with that slug can still be reached rather than an empty page
        out = C.resolve("weird_new_thing")
        assert "weird-new-thing" in out
