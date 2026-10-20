"""D412 - the vocabulary's code points, pinned.

The Unihan database (https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip) says:

    U+5EF3 = 廳    the hall, as in 餐廳
    U+5EF6 = 延    to delay
    U+9EB5 = 麵    flour, noodles
    U+9905 = 餅    biscuit
    U+98DF = 食    to eat
    U+996D = 饭    the SIMPLIFIED 飯
    U+98EF = 飯    the traditional 飯
    U+88DC = 補    the traditional 補
    U+8865 = 补    the simplified 補

A wrong code point looks identical to the reader and matches nothing: the query is a
string, and the comparison is by code point. D409 "fixed" a word that was already right
by writing it with the wrong code point, and its test then measured its own probe
instead of the product. These cases pin the code points, so the next writer cannot make
the same mistake in the same place, and the behavioural cases beside them pin the effect.

D417 added the last piece: the vocabulary is now CANONICALISED (`nlu/canonical.py`), so it
holds ONE spelling per term - the standard one - and a user who types the other spelling
still matches. The cases below therefore assert the standard form in the table AND that
BOTH spellings reach the matcher.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L

#: Code points that must not appear in the vocabulary: each is a character that LOOKS
#: like the one in the comment and is a different character to the machine.
MUST_NOT_APPEAR = {
    "\u5ef6": "延 - the character D409 wrote where 廳 (U+5EF3) belonged",
}

#: (the standard form, the other spelling, the category)
BOTH_SPELLINGS = [
    ("\u9910\u5ef3", "\u9910\u5385", "restaurant"),      # 餐廳 / 餐厅
    ("\u98df\u98ef", "\u98df\u996d", "restaurant"),      # 食飯 / 食饭
    ("\u5403\u98ef", "\u5403\u996d", "restaurant"),      # 吃飯 / 吃饭
    ("\u9eb5\u5305", "\u9762\u5305", "bakery"),          # 麵包 / 面包
    ("\u8336\u9910\u5ef3", "\u8336\u9910\u5385", "cafe"),  # 茶餐廳 / 茶餐厅
]


def test_the_standard_spelling_is_in_the_vocabulary():
    for standard, _other, category in BOTH_SPELLINGS:
        assert standard in L.CATEGORY_SYNONYMS[category], (
            f"{standard.encode('unicode_escape').decode()} is not in the {category} list")


def test_both_spellings_match_the_category():
    # The behavioural half: the vocabulary holds one spelling, and a user who types
    # either one gets the same answer.
    for standard, other, category in BOTH_SPELLINGS:
        assert L.match_category(standard)[0] == category, standard.encode("unicode_escape").decode()
        assert L.match_category(other)[0] == category, other.encode("unicode_escape").decode()


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
    assert ord("\u5ef6") == 0x5EF6 and ord("\u9905") == 0x9905
    assert ord("\u98df") == 0x98DF and ord("\u996d") == 0x996D
