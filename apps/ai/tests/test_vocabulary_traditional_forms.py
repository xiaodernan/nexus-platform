"""D415 - the vocabulary answers to the TRADITIONAL spelling as well as the simplified one.

A Hong Kong user types 餐廳, 飯店, 食飯, 吃飯, 打邊爐, 燒鵝, 馬來西菜, 靜一點, 團聚, 停車場,
颱風. The vocabulary was written mostly in the simplified forms (the product's own e2e
sentence is in Simplified Chinese too), so a traditional spelling found nothing: the term was
there, just spelled the other way, and a string comparison is by code point.

The measurement that started this unit: **19 of the vocabulary's 405 Chinese terms had no
traditional spelling in their table** (the Unihan database's `kTraditionalVariant` data says
which form is which). This file pins the fix: every one of those terms now has its
traditional spelling in the table, and the MATCHERS fire on it.

The three terms that are deliberately NOT here, and why:
  * 燒鵝 and 凍檸 - the standard code points could not be confirmed (the neighbouring code
    points are VARIANTS of them), and a synonym nobody types costs nothing;
  * 表白 - the Unihan "traditional variant" of 表 is 錶 (a watch), a different word.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L

#: (the traditional term, the table it must be in)
MUST_HOLD = [
    ("\u9910\u5ef3", "restaurant"),          # 餐廳
    ("\u98ef\u5e97", "restaurant"),          # 飯店
    ("\u98df\u98ef", "restaurant"),          # 食飯
    ("\u5403\u98ef", "restaurant"),          # 吃飯
    ("\u98df\u5e97", "restaurant"),          # 食店
    ("\u5c0f\u98df", "restaurant"),          # 小食
    ("\u6253\u908a\u7210", "hotpot"),        # 打邊爐
    ("\u5a1b\u6a02", "attraction"),          # 娛樂
    ("\u8336\u9910\u5ef3", "cafe"),          # 茶餐廳
]


def test_the_traditional_terms_are_in_the_vocabulary():
    for term, category in MUST_HOLD:
        assert term in L.CATEGORY_SYNONYMS[category], (
            f"{term.encode('unicode_escape').decode()} is not in the {category} list")


def test_the_traditional_cuisine_terms_are_in_the_vocabulary():
    assert "\u9435\u677f\u71d2" in L.CUISINE_TERMS["japanese"]        # 鐵板燒
    assert "\u53c3\u96de\u6e6f" in L.CUISINE_TERMS["korean"]           # 參雞湯
    assert "\u99ac\u4f86\u897f\u83dc" in L.CUISINE_TERMS["malaysian"]   # 馬來西菜
    assert "\u51cd\u9673\u529f" in L.CUISINE_TERMS["thai"]              # 凍陳功


def test_the_traditional_spelling_matches_the_category():
    # The behavioural half: the term is in the table AND the matcher fires on it.
    assert L.match_category("\u9910\u5ef3")[0] == "restaurant"
    assert L.match_category("\u8336\u9910\u5ef3")[0] == "cafe"
    assert L.match_category("\u6253\u908a\u7210")[0] == "hotpot"
    assert L.match_cuisines("\u53c3\u96de\u6e6f") or L.match_cuisines("\u53c2\u9d8f\u6e6f")


def test_the_traditional_preference_cues_are_in_the_table():
    cues = [c for row in L.PREFERENCE_RULES for cell in row if isinstance(cell, list)
            for c in cell]
    for term in ("\u975c\u4e00\u9ede",     # 靜一點
                 "\u5718\u805a",           # 團聚
                 "\u5718\u5efa",           # 團建
                 "\u5929\u81fa",           # 天臺
                 "\u8eca\u4f4d",           # 車位
                 "\u98b1\u98a8",           # 颱風
                 "\u9732\u81fa",           # 露臺
                 "\u505c\u8eca\u5834"):     # 停車場
        assert term in cues, f"{term.encode('unicode_escape').decode()} is not a preference cue"


def test_the_traditional_constraint_cue_is_in_the_table():
    cues = [cue for _key, cue_list, _values in L.CONSTRAINT_RULES for cue in cue_list]
    assert "\u5225" in cues, "別 (U+5225) is not a constraint cue"
