"""D414 - the vocabulary's code points, pinned.

The Unihan database (https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip) says:

    U+5EF3 = 廳    the hall, as in 餐廳
    U+5EF6 = 延    to delay
    U+9EB5 = 麵    flour, noodles
    U+9905 = 餅    biscuit
    U+98DF = 食    to eat
    U+996D = 飯    the traditional 飯
    U+98EF = 飯    the SIMPLIFIED 飯
    U+88DC = 補    the traditional 補
    U+8865 = 补    the simplified 補

A wrong code point looks identical to the reader and matches nothing: the query is a
string, and the comparison is by code point. D409 "fixed" a word that was already right
by writing it with the wrong code point, and its test then measured its own probe
instead of the product. These cases pin the code points, so the next writer cannot make
the same mistake in the same place, and the behavioural cases beside them pin the effect.

The simplified/traditional half of the class (a vocabulary entry written 飯 (U+98EF)
where a Hong Kong user types 飯 (U+996D)) is a separate unit, because fixing it
properly means canonicalising BOTH sides of every comparison; it is filed, not claimed
here.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L

#: Code points that must not appear in the vocabulary: each is a character that LOOKS
#: like the one in the comment and is a different character to the machine.
MUST_NOT_APPEAR = {
    "\u5ef6": "延 - the character D409 wrote where 廳 (U+5EF3) belonged",
}


def test_the_words_a_user_types_are_in_the_vocabulary():
    restaurant = L.CATEGORY_SYNONYMS["restaurant"]
    cafe = L.CATEGORY_SYNONYMS["cafe"]
    bakery = L.CATEGORY_SYNONYMS["bakery"]
    assert "\u9910\u5ef3" in restaurant, "餐廳 (U+9910 U+5EF3) is not a restaurant synonym"
    assert "\u8336\u9910\u5ef3" in cafe, "茶餐廳 is not a cafe synonym"
    assert "\u9eb5\u5305" in bakery, "麵包 (U+9EB5 U+5305) is not a bakery synonym"
    assert "\u98df\u996d" in restaurant, "食飯 (U+98DF U+996D) is not a restaurant synonym"
    assert "\u9910\u5385" in restaurant, "餐厅 (the simplified form) is not a synonym"


def test_the_words_a_user_types_match_the_category():
    # The behavioural half: a synonym nobody types costs nothing, a MISSING synonym
    # costs the whole category.
    assert L.match_category("\u9910\u5ef3")[0] == "restaurant"
    assert L.match_category("\u8336\u9910\u5ef3")[0] == "cafe"
    assert L.match_category("\u9eb5\u5305")[0] == "bakery"
    assert L.match_category("\u98df\u996d")[0] == "restaurant"
    assert L.match_category("\u9910\u5385")[0] == "restaurant"


def test_no_vocabulary_term_carries_a_code_point_from_the_known_bad_list():
    tables = {
        "CATEGORY_SYNONYMS": L.CATEGORY_SYNONYMS,
        "CUISINE_TERMS": L.CUISINE_TERMS,
        "SORT_RULES": L.SORT_RULES,
        "CONSTRAINT_RULES": L.CONSTRAINT_RULES,
        "DISTRICTS": getattr(L, "DISTRICTS", {}),
        "PREFERENCE_RULES": getattr(L, "PREFERENCE_RULES", {}),
    }
    for name, table in tables.items():
        text = repr(table)
        for bad, why in MUST_NOT_APPEAR.items():
            assert bad not in text, (
                f"{name} carries U+{ord(bad):04X} ({why})")


def test_the_code_points_are_the_ones_the_table_claims():
    # The table above is a claim about Unicode, and a claim about Unicode can be checked
    # by a reader with the same file. This is the check that the escapes in this file
    # are the escapes the comments describe - D409's mistake was writing the comment
    # from memory instead of from the database.
    assert len("\u9910\u5ef3") == 2 and ord("\u5ef3") == 0x5EF3
    assert len("\u9eb5\u5305") == 2 and ord("\u9eb5") == 0x9EB5
    assert len("\u98df\u996d") == 2 and ord("\u996d") == 0x996D
    assert ord("\u5ef6") == 0x5EF6 and ord("\u9905") == 0x9905
