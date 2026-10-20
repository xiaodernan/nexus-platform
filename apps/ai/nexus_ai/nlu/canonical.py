"""The canonical form of the characters this product's vocabulary uses.

A Hong Kong user types 餐廳; the seed's data and the product's own e2e sentence are in
Simplified Chinese; and a string comparison is by CODE POINT. A vocabulary written in one
spelling therefore cannot answer a user who writes the other - and §410 measured 19 terms
that had no traditional spelling at all.

This table is the fix, and it is DATA rather than a rule at run time: the Unihan database
(https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip) says which characters have
another spelling, and a character has one when the Unihan `kTraditionalVariant` names a
candidate that

  * has the same Cantonese reading,
  * has an overlapping `kDefinition` (a different DEFINITION is a different word), and
  * is not a glyph variant of it (a `kSemanticVariant`/`kZVariant` pair is the same
    character in another shape, not another spelling).

The rule rejects the traps the raw data contains: 别 lists 彆 ("awkward" - a different
word) as well as 別; 台 lists 颱 ("typhoon") as well as 臺; 板 lists 闆 and 家 lists 傢,
both glyph variants, so those two are already standard and must NOT be rewritten -
rewriting 座位 into 庢位 would break the word.

Every entry was checked against the Unihan readings and definitions, and the table holds
the 95 characters the vocabulary actually uses. `canonical()` is applied to the
QUERY (in `normalize_query`) and to the VOCABULARY terms (at import), so both sides of
every comparison speak the same spelling.

The query text that goes to SQL is NOT canonicalised: the corpus is indexed as it is, and
rewriting the text that is matched against the index would change WHICH rows match - a
separate measurement, filed, not assumed.
"""

from __future__ import annotations

#: simplified -> the standard spelling. The characters are written as escapes on purpose:
#: D409's lesson was that a writer's memory of a CJK code point is not a reference.
CANONICAL_FORMS: dict[str, str] = {
    "\u4e1a": "\u696d",  # \u4e1a -> \u696d
    "\u4e50": "\u6a02",  # \u4e50 -> \u6a02
    "\u4e60": "\u7fd2",  # \u4e60 -> \u7fd2
    "\u4e70": "\u8cb7",  # \u4e70 -> \u8cb7
    "\u4e9a": "\u4e9e",  # \u4e9a -> \u4e9e
    "\u4eb2": "\u89aa",  # \u4eb2 -> \u89aa
    "\u5185": "\u5167",  # \u5185 -> \u5167
    "\u519b": "\u8ecd",  # \u519b -> \u8ecd
    "\u522b": "\u5225",  # \u522b -> \u5225
    "\u5267": "\u5287",  # \u5267 -> \u5287
    "\u52a1": "\u52d9",  # \u52a1 -> \u52d9
    "\u52a8": "\u52d5",  # \u52a8 -> \u52d5
    "\u5385": "\u5ef3",  # \u5385 -> \u5ef3
    "\u53c2": "\u53c3",  # \u53c2 -> \u53c3
    "\u53d1": "\u767c",  # \u53d1 -> \u767c
    "\u542f": "\u5553",  # \u542f -> \u5553
    "\u56e2": "\u5718",  # \u56e2 -> \u5718
    "\u56ed": "\u5712",  # \u56ed -> \u5712
    "\u56f4": "\u570d",  # \u56f4 -> \u570d
    "\u56fd": "\u570b",  # \u56fd -> \u570b
    "\u573a": "\u5834",  # \u573a -> \u5834
    "\u5ba0": "\u5bf5",  # \u5ba0 -> \u5bf5
    "\u5bbe": "\u8cd3",  # \u5bbe -> \u8cd3
    "\u5c06": "\u5c07",  # \u5c06 -> \u5c07
    "\u5c7f": "\u5dbc",  # \u5c7f -> \u5dbc
    "\u5e26": "\u5e36",  # \u5e26 -> \u5e36
    "\u5f00": "\u958b",  # \u5f00 -> \u958b
    "\u620f": "\u6232",  # \u620f -> \u6232
    "\u62a4": "\u8b77",  # \u62a4 -> \u8b77
    "\u6570": "\u6578",  # \u6570 -> \u6578
    "\u6740": "\u6bba",  # \u6740 -> \u6bba
    "\u69df": "\u6ab3",  # \u69df -> \u6ab3
    "\u6c14": "\u6c23",  # \u6c14 -> \u6c23
    "\u6c49": "\u6f22",  # \u6c49 -> \u6f22
    "\u6d4e": "\u6fdf",  # \u6d4e -> \u6fdf
    "\u6e7e": "\u7063",  # \u6e7e -> \u7063
    "\u6e7f": "\u6fd5",  # \u6e7f -> \u6fd5
    "\u6ee8": "\u6ff1",  # \u6ee8 -> \u6ff1
    "\u70e7": "\u71d2",  # \u70e7 -> \u71d2
    "\u70ed": "\u71b1",  # \u70ed -> \u71b1
    "\u73af": "\u74b0",  # \u73af -> \u74b0
    "\u7535": "\u96fb",  # \u7535 -> \u96fb
    "\u7597": "\u7642",  # \u7597 -> \u7642
    "\u7801": "\u78bc",  # \u7801 -> \u78bc
    "\u7ea2": "\u7d05",  # \u7ea2 -> \u7d05
    "\u7ea6": "\u7d04",  # \u7ea6 -> \u7d04
    "\u7ea7": "\u7d1a",  # \u7ea7 -> \u7d1a
    "\u7eaf": "\u7d14",  # \u7eaf -> \u7d14
    "\u7ebf": "\u7dab",  # \u7ebf -> \u7dab
    "\u7ecf": "\u7d93",  # \u7ecf -> \u7d93
    "\u7ef4": "\u7dad",  # \u7ef4 -> \u7dad
    "\u80a4": "\u819a",  # \u80a4 -> \u819a
    "\u8111": "\u8166",  # \u8111 -> \u8166
    "\u8425": "\u71df",  # \u8425 -> \u71df
    "\u8865": "\u88dc",  # \u8865 -> \u88dc
    "\u89c2": "\u89c0",  # \u89c2 -> \u89c0
    "\u8ba2": "\u8a02",  # \u8ba2 -> \u8a02
    "\u8bae": "\u8b70",  # \u8bae -> \u8b70
    "\u8bc4": "\u8a55",  # \u8bc4 -> \u8a55
    "\u8bca": "\u8a3a",  # \u8bca -> \u8a3a
    "\u8bdd": "\u8a71",  # \u8bdd -> \u8a71
    "\u8bf7": "\u8acb",  # \u8bf7 -> \u8acb
    "\u8bfe": "\u8ab2",  # \u8bfe -> \u8ab2
    "\u8c03": "\u8abf",  # \u8c03 -> \u8abf
    "\u8d27": "\u8ca8",  # \u8d27 -> \u8ca8
    "\u8d2d": "\u8cfc",  # \u8d2d -> \u8cfc
    "\u8f66": "\u8eca",  # \u8f66 -> \u8eca
    "\u8f6e": "\u8f2a",  # \u8f6e -> \u8f2a
    "\u8f83": "\u8f03",  # \u8f83 -> \u8f03
    "\u8fd0": "\u904b",  # \u8fd0 -> \u904b
    "\u90bb": "\u9130",  # \u90bb -> \u9130
    "\u949f": "\u9418",  # \u949f -> \u9418
    "\u94b1": "\u9322",  # \u94b1 -> \u9322
    "\u94c1": "\u9435",  # \u94c1 -> \u9435
    "\u94dc": "\u9285",  # \u94dc -> \u9285
    "\u9505": "\u934b",  # \u9505 -> \u934b
    "\u9523": "\u947c",  # \u9523 -> \u947c
    "\u957f": "\u9577",  # \u957f -> \u9577
    "\u95ee": "\u554f",  # \u95ee -> \u554f
    "\u95f4": "\u9593",  # \u95f4 -> \u9593
    "\u95f9": "\u9b27",  # \u95f9 -> \u9b27
    "\u961f": "\u968a",  # \u961f -> \u968a
    "\u9759": "\u975c",  # \u9759 -> \u975c
    "\u97e9": "\u97d3",  # \u97e9 -> \u97d3
    "\u9876": "\u9802",  # \u9876 -> \u9802
    "\u9884": "\u9810",  # \u9884 -> \u9810
    "\u98ce": "\u98a8",  # \u98ce -> \u98a8
    "\u996a": "\u98ea",  # \u996a -> \u98ea
    "\u996d": "\u98ef",  # \u996d -> \u98ef
    "\u996e": "\u98f2",  # \u996e -> \u98f2
    "\u997c": "\u9905",  # \u997c -> \u9905
    "\u9986": "\u9928",  # \u9986 -> \u9928
    "\u9a6c": "\u99ac",  # \u9a6c -> \u99ac
    "\u9c9c": "\u9bae",  # \u9c9c -> \u9bae
    "\u9f99": "\u9f8d",  # \u9f99 -> \u9f8d
}


def canonical(text: str) -> str:
    """The text in the spelling the vocabulary and the user both understand."""
    if not text:
        return text
    return "".join(CANONICAL_FORMS.get(ch, ch) for ch in text)


__all__ = ["CANONICAL_FORMS", "canonical"]
