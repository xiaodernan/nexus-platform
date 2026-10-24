"""The canonical form of the characters this product's vocabulary uses.

A Hong Kong user types 餐廳; the seed's data and the product's own e2e sentence are in
Simplified Chinese; and a string comparison is by CODE POINT. A vocabulary written in one
spelling therefore cannot answer a user who writes the other - and §410 measured 19 terms
that had no traditional spelling at all.

This table is the fix, and it is DATA rather than a rule at run time: the Unihan database
(https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip) says which characters have
another spelling, and a character has one when the Unihan `kTraditionalVariant` names a
candidate that

  * has the same Cantonese reading, and
  * has an overlapping `kDefinition`.

The two tests are what reject the traps the raw data contains: 别 lists 彆 ("awkward" - a
different word) as well as 別; 台 lists 颱 ("typhoon" - the typhoon's own form) as well as
臺; 板 lists 闆 ("door panel") and 家 lists 傢 ("household servant"). A candidate with a
different reading or a different meaning is a different word, and rewriting a word with it
would break the word - 座位 must not become 庢位.

NOTE (D421): the kSemanticVariant relation is NOT a disqualifier. Unihan lists the
simplified and the traditional forms of the SAME word as semantic variants (点/點,
热/熱), because they are the same character in two spellings - and excluding them left
the merge cues uncovered: 近一點 matched nothing while 近一点 did.

Every entry was checked against the Unihan readings and definitions. The table covers
every Chinese character in the product's own sources - the 832 characters of the
lexicon, the state merger's cue lists and the matchers' inline regexes - because the
product's Chinese lives in more than one vocabulary, and a character only ONE of them
uses is a character the canonicalisation would ignore.

`canonical()` is applied to the QUERY (in the NLU's cue matching) and to the VOCABULARY
terms (at import), so both sides of every comparison speak the same spelling. The LOCALE
is read from the user's own spelling (D420), and the text matched against the corpus's
index is canonicalised too (D418: 0 of the corpus's 470 published rows hold a character
this table changes, so that can only add matches).
"""

from __future__ import annotations

from typing import Any

#: simplified -> the standard spelling. The characters are written as escapes on purpose:
#: D409's lesson was that a writer's memory of a CJK code point is not a reference.
CANONICAL_FORMS: dict[str, str] = {
    "\u4e0e": "\u8207",  # \u4e0e -> \u8207
    "\u4e1a": "\u696d",  # \u4e1a -> \u696d
    "\u4e1c": "\u6771",  # \u4e1c -> \u6771
    "\u4e24": "\u5169",  # \u4e24 -> \u5169
    "\u4e2a": "\u500b",  # \u4e2a -> \u500b
    "\u4e34": "\u81e8",  # \u4e34 -> \u81e8
    "\u4e3a": "\u70ba",  # \u4e3a -> \u70ba
    "\u4e49": "\u7fa9",  # \u4e49 -> \u7fa9
    "\u4e50": "\u6a02",  # \u4e50 -> \u6a02
    "\u4e60": "\u7fd2",  # \u4e60 -> \u7fd2
    "\u4e66": "\u66f8",  # \u4e66 -> \u66f8
    "\u4e70": "\u8cb7",  # \u4e70 -> \u8cb7
    "\u4e8e": "\u65bc",  # \u4e8e -> \u65bc
    "\u4e91": "\u96f2",  # \u4e91 -> \u96f2
    "\u4e9a": "\u4e9e",  # \u4e9a -> \u4e9e
    "\u4ea7": "\u7522",  # \u4ea7 -> \u7522
    "\u4eb2": "\u89aa",  # \u4eb2 -> \u89aa
    "\u4eec": "\u5011",  # \u4eec -> \u5011
    "\u4ef7": "\u50f9",  # \u4ef7 -> \u50f9
    "\u4f18": "\u512a",  # \u4f18 -> \u512a
    "\u4f1a": "\u6703",  # \u4f1a -> \u6703
    "\u4f53": "\u9ad4",  # \u4f53 -> \u9ad4
    "\u4fa3": "\u4fb6",  # \u4fa3 -> \u4fb6
    "\u5173": "\u95dc",  # \u5173 -> \u95dc
    "\u5185": "\u5167",  # \u5185 -> \u5167
    "\u519b": "\u8ecd",  # \u519b -> \u8ecd
    "\u51c6": "\u6e96",  # \u51c6 -> \u6e96
    "\u51e4": "\u9cf3",  # \u51e4 -> \u9cf3
    "\u5212": "\u5283",  # \u5212 -> \u5283
    "\u5219": "\u5247",  # \u5219 -> \u5247
    "\u522b": "\u5225",  # \u522b -> \u5225
    "\u5267": "\u5287",  # \u5267 -> \u5287
    "\u52a1": "\u52d9",  # \u52a1 -> \u52d9
    "\u52a8": "\u52d5",  # \u52a8 -> \u52d5
    "\u533a": "\u5340",  # \u533a -> \u5340
    "\u533b": "\u91ab",  # \u533b -> \u91ab
    "\u534e": "\u83ef",  # \u534e -> \u83ef
    "\u534f": "\u5354",  # \u534f -> \u5354
    "\u5355": "\u55ae",  # \u5355 -> \u55ae
    "\u5360": "\u4f54",  # \u5360 -> \u4f54
    "\u5385": "\u5ef3",  # \u5385 -> \u5ef3
    "\u53c2": "\u53c3",  # \u53c2 -> \u53c3
    "\u53cc": "\u96d9",  # \u53cc -> \u96d9
    "\u53d1": "\u767c",  # \u53d1 -> \u767c
    "\u53f0": "\u81fa",  # \u53f0 -> \u81fa
    "\u53f6": "\u8449",  # \u53f6 -> \u8449
    "\u53f7": "\u865f",  # \u53f7 -> \u865f
    "\u542f": "\u5553",  # \u542f -> \u5553
    "\u5458": "\u54e1",  # \u5458 -> \u54e1
    "\u56e2": "\u5718",  # \u56e2 -> \u5718
    "\u56ed": "\u5712",  # \u56ed -> \u5712
    "\u56f4": "\u570d",  # \u56f4 -> \u570d
    "\u56fd": "\u570b",  # \u56fd -> \u570b
    "\u56fe": "\u5716",  # \u56fe -> \u5716
    "\u573a": "\u5834",  # \u573a -> \u5834
    "\u5907": "\u5099",  # \u5907 -> \u5099
    "\u590d": "\u5fa9",  # \u590d -> \u5fa9
    "\u5934": "\u982d",  # \u5934 -> \u982d
    "\u5a31": "\u5a1b",  # \u5a31 -> \u5a1b
    "\u5b66": "\u5b78",  # \u5b66 -> \u5b78
    "\u5b9e": "\u5be6",  # \u5b9e -> \u5be6
    "\u5ba0": "\u5bf5",  # \u5ba0 -> \u5bf5
    "\u5bbe": "\u8cd3",  # \u5bbe -> \u8cd3
    "\u5bf9": "\u5c0d",  # \u5bf9 -> \u5c0d
    "\u5bfb": "\u5c0b",  # \u5bfb -> \u5c0b
    "\u5bff": "\u58fd",  # \u5bff -> \u58fd
    "\u5c06": "\u5c07",  # \u5c06 -> \u5c07
    "\u5c42": "\u5c64",  # \u5c42 -> \u5c64
    "\u5c7f": "\u5dbc",  # \u5c7f -> \u5dbc
    "\u5e01": "\u5e63",  # \u5e01 -> \u5e63
    "\u5e05": "\u5e25",  # \u5e05 -> \u5e25
    "\u5e08": "\u5e2b",  # \u5e08 -> \u5e2b
    "\u5e10": "\u5e33",  # \u5e10 -> \u5e33
    "\u5e26": "\u5e36",  # \u5e26 -> \u5e36
    "\u5e2e": "\u5e6b",  # \u5e2e -> \u5e6b
    "\u5e72": "\u5e79",  # \u5e72 -> \u5e79
    "\u5e76": "\u4e26",  # \u5e76 -> \u4e26
    "\u5e7f": "\u5ee3",  # \u5e7f -> \u5ee3
    "\u5e84": "\u838a",  # \u5e84 -> \u838a
    "\u5f00": "\u958b",  # \u5f00 -> \u958b
    "\u5f20": "\u5f35",  # \u5f20 -> \u5f35
    "\u5f3a": "\u5f37",  # \u5f3a -> \u5f37
    "\u60ca": "\u9a5a",  # \u60ca -> \u9a5a
    "\u620f": "\u6232",  # \u620f -> \u6232
    "\u6237": "\u6236",  # \u6237 -> \u6236
    "\u62a4": "\u8b77",  # \u62a4 -> \u8b77
    "\u62e9": "\u64c7",  # \u62e9 -> \u64c7
    "\u6362": "\u63db",  # \u6362 -> \u63db
    "\u6570": "\u6578",  # \u6570 -> \u6578
    "\u65e0": "\u7121",  # \u65e0 -> \u7121
    "\u65f6": "\u6642",  # \u65f6 -> \u6642
    "\u663e": "\u986f",  # \u663e -> \u986f
    "\u672f": "\u8853",  # \u672f -> \u8853
    "\u673a": "\u6a5f",  # \u673a -> \u6a5f
    "\u6740": "\u6bba",  # \u6740 -> \u6bba
    "\u6742": "\u96dc",  # \u6742 -> \u96dc
    "\u6765": "\u4f86",  # \u6765 -> \u4f86
    "\u6781": "\u6975",  # \u6781 -> \u6975
    "\u6784": "\u69cb",  # \u6784 -> \u69cb
    "\u6807": "\u6a19",  # \u6807 -> \u6a19
    "\u697c": "\u6a13",  # \u697c -> \u6a13
    "\u69df": "\u6ab3",  # \u69df -> \u6ab3
    "\u6b22": "\u6b61",  # \u6b22 -> \u6b61
    "\u6c14": "\u6c23",  # \u6c14 -> \u6c23
    "\u6c49": "\u6f22",  # \u6c49 -> \u6f22
    "\u6c64": "\u6e6f",  # \u6c64 -> \u6e6f
    "\u6c9f": "\u6e9d",  # \u6c9f -> \u6e9d
    # D547: the product's own negation word, in the spelling a Simplified user types.
    # Unihan: same Cantonese reading (mut6), overlapping kDefinition ("not, have not,
    # no"). It was in NO table - not the canon, not the negation cues, not the locale
    # markers - so "没食辣" wrote no constraint and read the spicy +1, a LIKE of the
    # very cuisine the user refused, while "沒有食辣" read the refusal in both lanes.
    "\u6ca1": "\u6c92",  # \u6ca1 -> \u6c92
    "\u6d4b": "\u6e2c",  # \u6d4b -> \u6e2c
    "\u6d4e": "\u6fdf",  # \u6d4e -> \u6fdf
    "\u6d82": "\u5857",  # \u6d82 -> \u5857
    "\u6da6": "\u6f64",  # \u6da6 -> \u6f64
    "\u6da8": "\u6f32",  # \u6da8 -> \u6f32
    "\u6e7e": "\u7063",  # \u6e7e -> \u7063
    "\u6e7f": "\u6fd5",  # \u6e7f -> \u6fd5
    "\u6ee8": "\u6ff1",  # \u6ee8 -> \u6ff1
    "\u706f": "\u71c8",  # \u706f -> \u71c8
    "\u7075": "\u9748",  # \u7075 -> \u9748
    "\u7089": "\u7210",  # \u7089 -> \u7210
    "\u70b9": "\u9ede",  # \u70b9 -> \u9ede
    "\u70c2": "\u721b",  # \u70c2 -> \u721b
    "\u70df": "\u7159",  # \u70df -> \u7159
    "\u70e7": "\u71d2",  # \u70e7 -> \u71d2
    "\u70ed": "\u71b1",  # \u70ed -> \u71b1
    "\u7231": "\u611b",  # \u7231 -> \u611b
    "\u72ec": "\u7368",  # \u72ec -> \u7368
    "\u732a": "\u8c6c",  # \u732a -> \u8c6c
    "\u732b": "\u8c93",  # \u732b -> \u8c93
    "\u73af": "\u74b0",  # \u73af -> \u74b0
    "\u73b0": "\u73fe",  # \u73b0 -> \u73fe
    "\u7535": "\u96fb",  # \u7535 -> \u96fb
    "\u7597": "\u7642",  # \u7597 -> \u7642
    "\u76d6": "\u84cb",  # \u76d6 -> \u84cb
    "\u7801": "\u78bc",  # \u7801 -> \u78bc
    "\u788d": "\u7919",  # \u788d -> \u7919
    "\u793c": "\u79ae",  # \u793c -> \u79ae
    "\u79ef": "\u7a4d",  # \u79ef -> \u7a4d
    "\u7b51": "\u7bc9",  # \u7b51 -> \u7bc9
    "\u7b80": "\u7c21",  # \u7b80 -> \u7c21
    "\u7ca4": "\u7cb5",  # \u7ca4 -> \u7cb5
    "\u7ea2": "\u7d05",  # \u7ea2 -> \u7d05
    "\u7ea6": "\u7d04",  # \u7ea6 -> \u7d04
    "\u7ea7": "\u7d1a",  # \u7ea7 -> \u7d1a
    "\u7eaa": "\u7d00",  # \u7eaa -> \u7d00
    "\u7eaf": "\u7d14",  # \u7eaf -> \u7d14
    "\u7ebf": "\u7dab",  # \u7ebf -> \u7dab
    "\u7ecf": "\u7d93",  # \u7ecf -> \u7d93
    "\u7edc": "\u7d61",  # \u7edc -> \u7d61
    "\u7ef4": "\u7dad",  # \u7ef4 -> \u7dad
    "\u7f51": "\u7db2",  # \u7f51 -> \u7db2
    "\u80a4": "\u819a",  # \u80a4 -> \u819a
    "\u8111": "\u8166",  # \u8111 -> \u8166
    "\u814a": "\u81d8",  # \u814a -> \u81d8
    "\u827a": "\u85dd",  # \u827a -> \u85dd
    "\u8282": "\u7bc0",  # \u8282 -> \u7bc0
    "\u8303": "\u7bc4",  # \u8303 -> \u7bc4
    "\u8350": "\u85a6",  # \u8350 -> \u85a6
    "\u8425": "\u71df",  # \u8425 -> \u71df
    "\u8471": "\u8525",  # \u8471 -> \u8525
    "\u8865": "\u88dc",  # \u8865 -> \u88dc
    "\u89c2": "\u89c0",  # \u89c2 -> \u89c0
    "\u89c9": "\u89ba",  # \u89c9 -> \u89ba
    "\u8ba1": "\u8a08",  # \u8ba1 -> \u8a08
    "\u8ba2": "\u8a02",  # \u8ba2 -> \u8a02
    "\u8ba9": "\u8b93",  # \u8ba9 -> \u8b93
    "\u8bae": "\u8b70",  # \u8bae -> \u8b70
    "\u8bbe": "\u8a2d",  # \u8bbe -> \u8a2d
    "\u8bc1": "\u8b49",  # \u8bc1 -> \u8b49
    "\u8bc4": "\u8a55",  # \u8bc4 -> \u8a55
    "\u8bca": "\u8a3a",  # \u8bca -> \u8a3a
    "\u8bdd": "\u8a71",  # \u8bdd -> \u8a71
    "\u8bf4": "\u8aaa",  # \u8bf4 -> \u8aaa
    "\u8bf7": "\u8acb",  # \u8bf7 -> \u8acb
    "\u8bfe": "\u8ab2",  # \u8bfe -> \u8ab2
    "\u8c03": "\u8abf",  # \u8c03 -> \u8abf
    "\u8c13": "\u8b02",  # \u8c13 -> \u8b02
    "\u8d27": "\u8ca8",  # \u8d27 -> \u8ca8
    "\u8d28": "\u8cea",  # \u8d28 -> \u8cea
    "\u8d2d": "\u8cfc",  # \u8d2d -> \u8cfc
    "\u8d35": "\u8cb4",  # \u8d35 -> \u8cb4
    "\u8f66": "\u8eca",  # \u8f66 -> \u8eca
    "\u8f6e": "\u8f2a",  # \u8f6e -> \u8f2a
    "\u8f83": "\u8f03",  # \u8f83 -> \u8f03
    "\u8f86": "\u8f1b",  # \u8f86 -> \u8f1b
    "\u8fb9": "\u908a",  # \u8fb9 -> \u908a
    "\u8fc7": "\u904e",  # \u8fc7 -> \u904e
    "\u8fd0": "\u904b",  # \u8fd0 -> \u904b
    "\u8fd8": "\u9084",  # \u8fd8 -> \u9084
    "\u8fd9": "\u9019",  # \u8fd9 -> \u9019
    "\u8fdc": "\u9060",  # \u8fdc -> \u9060
    "\u9002": "\u9069",  # \u9002 -> \u9069
    "\u9009": "\u9078",  # \u9009 -> \u9078
    "\u90bb": "\u9130",  # \u90bb -> \u9130
    "\u949f": "\u9418",  # \u949f -> \u9418
    "\u94b1": "\u9322",  # \u94b1 -> \u9322
    "\u94c1": "\u9435",  # \u94c1 -> \u9435
    "\u94dc": "\u9285",  # \u94dc -> \u9285
    "\u9505": "\u934b",  # \u9505 -> \u934b
    "\u9523": "\u947c",  # \u9523 -> \u947c
    "\u957f": "\u9577",  # \u957f -> \u9577
    "\u95e8": "\u9580",  # \u95e8 -> \u9580
    "\u95ee": "\u554f",  # \u95ee -> \u554f
    "\u95f2": "\u9591",  # \u95f2 -> \u9591
    "\u95f4": "\u9593",  # \u95f4 -> \u9593
    "\u95f9": "\u9b27",  # \u95f9 -> \u9b27
    "\u961f": "\u968a",  # \u961f -> \u968a
    "\u9634": "\u9670",  # \u9634 -> \u9670
    "\u9645": "\u969b",  # \u9645 -> \u969b
    "\u968f": "\u96a8",  # \u968f -> \u96a8
    "\u9759": "\u975c",  # \u9759 -> \u975c
    "\u9762": "\u9eb5",  # \u9762 -> \u9eb5
    "\u97e9": "\u97d3",  # \u97e9 -> \u97d3
    "\u9875": "\u9801",  # \u9875 -> \u9801
    "\u9876": "\u9802",  # \u9876 -> \u9802
    "\u987a": "\u9806",  # \u987a -> \u9806
    "\u987b": "\u9808",  # \u987b -> \u9808
    "\u9882": "\u980c",  # \u9882 -> \u980c
    "\u9884": "\u9810",  # \u9884 -> \u9810
    "\u988a": "\u9830",  # \u988a -> \u9830
    "\u9898": "\u984c",  # \u9898 -> \u984c
    "\u989c": "\u984f",  # \u989c -> \u984f
    "\u989d": "\u984d",  # \u989d -> \u984d
    "\u98ce": "\u98a8",  # \u98ce -> \u98a8
    "\u98de": "\u98db",  # \u98de -> \u98db
    "\u996a": "\u98ea",  # \u996a -> \u98ea
    "\u996d": "\u98ef",  # \u996d -> \u98ef
    "\u996e": "\u98f2",  # \u996e -> \u98f2
    "\u9970": "\u98fe",  # \u9970 -> \u98fe
    "\u997c": "\u9905",  # \u997c -> \u9905
    "\u9986": "\u9928",  # \u9986 -> \u9928
    "\u9a6c": "\u99ac",  # \u9a6c -> \u99ac
    "\u9a91": "\u9a0e",  # \u9a91 -> \u9a0e
    "\u9a97": "\u9a19",  # \u9a97 -> \u9a19
    "\u9c7c": "\u9b5a",  # \u9c7c -> \u9b5a
    "\u9c9c": "\u9bae",  # \u9c9c -> \u9bae
    "\u9e1f": "\u9ce5",  # \u9e1f -> \u9ce5
    "\u9e21": "\u9dc4",  # \u9e21 -> \u9dc4
    "\u9e2d": "\u9d28",  # \u9e2d -> \u9d28
    "\u9f99": "\u9f8d",  # \u9f99 -> \u9f8d
}


def canonical(text: str) -> str:
    """The text in the spelling the vocabulary and the user both understand."""
    if not text:
        return text
    return "".join(CANONICAL_FORMS.get(ch, ch) for ch in text)


def canonical_node(node: Any) -> Any:
    """Canonicalise every string inside a table, keeping its structure.

    The vocabulary's tables are held in the canonical spelling (D435), and the structure of
    a table is not changed by the spelling of its contents: a list that held the same cue
    twice still holds it twice, so every derived list and every test that compares them
    still compares the same shape.
    """
    if isinstance(node, str):
        return canonical(node)
    if isinstance(node, list):
        return [canonical_node(item) for item in node]
    if isinstance(node, tuple):
        return tuple(canonical_node(item) for item in node)
    if isinstance(node, dict):
        return {canonical_node(k): canonical_node(v) for k, v in node.items()}
    return node


__all__ = ["CANONICAL_FORMS", "canonical", "canonical_node"]
