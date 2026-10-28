"""D601 - a word that names ONE taxonomy leaf was answered with its whole root.

`match_category` answers a coarse bucket, and that is the contract's `Intent.category`
(`API_CONTRACT.md` §7.1: `"category": "restaurant", // null when not stated`). A bucket is
coarser than the leaf a caller named, and the search filter is where that refinement belongs:

* 按摩 / 髮型屋 / 護膚 resolved to `beauty` - a root that admits all six beauty leaves - so a
  massage query was answered with nail salons and hair salons (top-10 precision 0.3 measured on
  the live plane by D600's door, 髮型屋 0.4, 護膚 0.3);
* 珍珠奶茶 matched no category at all (0.0): the page was whatever the keyword lane ranked;
* 壽司 / 拉麵 / 點心 were answered through `category=restaurant` plus a soft `cuisine=japanese`
  preference (0.5 / 0.8 / 0.9).

`nlu.lexicon.LEAF_SYNONYMS` names the leaves whose meaning is one leaf and `match_leaf` answers
the leaf a query's HEAD names (rightmost cue, ties by length - so 拉麵店的咖啡 stays a cafe and
咖啡店的拉麵 is ramen). `plan_from_intent` writes that leaf into `filters["category"]`, which both
lanes already read and which the SQL clause already resolves exactly when the spelling is a
leaf (D524). The intent lane's own `category` is untouched, so the contract and its eval suite
keep asserting `restaurant`.

A caller who passed their own `category` filter keeps it: a chip on a card outranks a word in
the query.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import match_category, match_leaf
from nexus_ai.search.service import plan_from_intent

LEAVES = {
    "拉麵": "ramen", "拉面": "ramen", "sushi": "sushi", "壽司": "sushi",
    "點心": "dimsum", "dim sum": "dimsum", "火鍋": "hotpot",
    "按摩": "spa-massage", "massage": "spa-massage", "水療": "spa-massage",
    "髮型屋": "hair-salon", "理髮": "hair-salon", "haircut": "hair-salon",
    "美甲": "nail-salon", "護膚": "skin-clinic", "珍珠奶茶": "bubble-tea", "奶茶": "bubble-tea",
}


@pytest.mark.parametrize("word,leaf", sorted(LEAVES.items()))
def test_the_word_answers_its_leaf(word, leaf):
    assert match_leaf(word) == leaf


@pytest.mark.parametrize("word", ["咖啡", "酒吧", "甜品", "餐廳", "安靜的咖啡店",
                                 "適合情侶約會的地方", "", "escape room"])
def test_a_word_that_names_no_single_leaf_answers_none(word):
    assert match_leaf(word) is None, (
        f"{word!r} was answered with a leaf the corpus does not file it under")


def test_the_head_noun_decides():
    """CJK puts the head last: the leaf answers only when nothing coarser follows it."""
    assert match_leaf("拉麵店的咖啡") is None
    assert match_leaf("咖啡店的拉麵") == "ramen"


def test_the_contract_field_is_still_the_coarse_bucket():
    """The refinement is the SEARCH plan's, not the intent lane's."""
    from nexus_ai.nlu.understand import extract_intent_dict

    assert extract_intent_dict("拉麵").get("category") == "restaurant"
    assert extract_intent_dict("按摩").get("category") == "beauty"
    assert match_category("按摩")[0] == "beauty"
    plan = plan_from_intent(None, query="拉麵")
    assert plan.filters.get("category") == "ramen"


def test_a_callers_own_category_filter_wins():
    plan = plan_from_intent(None, query="拉麵", filters={"category": "bar"})
    assert plan.filters.get("category") == "bar", (
        "a word in the query overrode the filter the caller named")
