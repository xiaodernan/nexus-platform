"""The vocabulary is the reference for a CJK code point - in the test files too.

D409 was a defect that did not exist: the probe spelled the restaurant word with the
wrong code point (U+5EF6, which the Unihan database calls "delay, postpone, defer"),
the probe matched nothing, and the "fix" made the vocabulary match the probe's typo.
D414 withdrew it, and D416/D417 rebuilt the vocabulary against the Unihan database.

The lesson is that a hand-written CJK code point is not a reference, and this test is
the reference the repo can carry without shipping the Unihan data: **a character the
product's own vocabulary knows is a character the product can answer for.** A test that
uses a character nobody knows is a test asserting a word the platform has never heard of
- and it fails for a reason that has nothing to do with the behaviour under test.

D434 built this for the evaluation's INTENT cases. Writing it found THREE wrong code
points in the evaluation's own price case - and the case had been PASSING, because a
single-character cue fired on its own, so the case was not testing the phrase it claimed
to test.

D453 widens it to the TEST FILES, which is where the wrong code point actually hides.
The reference is now DERIVED from the product's own package - every Chinese character it
carries, its data and not its prose - so a new vocabulary table is in the reference the
moment it exists. The hand-kept list of tables was the same stale-list problem D435 and
D447 found in the census: a reference somebody has to remember to update is a reference
that goes out of date.

What the wider gate found in the test files:

  * U+95A9 ("Fujian province; a river; a tribe") written where U+95F9 ("quarrel;
    dispute hotly") belonged - in a table NOTHING READ. D449's lesson: a dead table is
    where the product's description of itself rots, and it rots quietly.
  * U+5584 ("good, virtuous, charitable, kind") written where U+5566 ("final particle
    of assertion", the Cantonese negation) belonged - in a test that PASSED, because the
    cue that fired was the other word in the same phrase.

Both were confirmed against the Unihan database, never against a memory: the writer's
memory of a CJK code point is not a reference (D409, D446).

The injection suite is deliberately NOT in the scope of the case gate: its payloads are
ATTACKS, and an attack is supposed to use words the platform has never heard of. The
characters those payloads use are DECLARED below.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

from nexus_ai.nlu.canonical import canonical

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "nexus_ai"
TESTS = REPO / "tests"
DATA = PACKAGE / "eval" / "data"

#: The characters the tests use that the product's vocabulary does not carry, DECLARED.
#: Each one is a word the platform has no business knowing - a grammatical word, a brand,
#: an attack's payload, a demo merchant's name - and each entry says what the Unihan
#: database calls it and what the test that uses it is doing. The characters and the
#: glosses come from the Unihan database itself (Unihan_Readings.txt, kDefinition), not
#: from the writer's memory: that is the whole point of the file.
#:
#:   #:   (the block below is generated from the Unihan database)

DECLARED = {
    "\u4ec5",   # 仅 - only, merely, solely, just - a demo merchant's name (only stairs)
    "\u52a9",   # 助 - help, aid, assist - a sponsored label the test supplies
    "\u53c9",   # 叉 - crotch; fork, prong - a menu item in a demo row (char siu rice)
    "\u55ef",   # 嗯 - final particle - a turn that is not a request at all
    "\u5605",   # 嘅 - sound of sighing; (Cant.) possessive - the Cantonese particle that joins the words in a query - the product's tables hold the words,
                   # not the grammar
    "\u5622",   # 嘢 - (Cant.) thing - the Cantonese shopping cue (to buy things)
    "\u5904",   # 处 - place, locale; department - a demo merchant's name (the far cafe)
    "\u5ea7",   # 座 - seat; stand, base - the query that asks for a socket
    "\u5ef6",   # 延 - delay, postpone, defer - the character D409 wrote where the restaurant word belonged - the known-bad list pins it
    "\u5f15",   # 引 - to pull, draw out, attract; to stretch - the query with no quotation marks
    "\u628a",   # 把 - hold, take; guard; regard as - an injection payload - an attack is allowed to use words the platform has never heard of
    "\u63d2",   # 插 - insert, stick into; plant - the query that asks for a socket
    "\u6488",   # 撈 - scoop out of water; dredge, fish - a quoted brand name
    "\u6539",   # 改 - change, alter; improve, remodel - an injection payload
    "\u6587",   # 文 - literature, culture, writing - the normalisation test's mixed-script string
    "\u684c",   # 桌 - table, desk, stand - the table cue (the other spelling of the word for a table)
    "\u68af",   # 梯 - ladder, steps, stairs; lean - a demo merchant's name (only stairs)
    "\u6c92",   # 沒 - not, have not, none; to drown, sink - the query with no quotation marks
    "\u6de1",   # 淡 - weak, watery; insipid, tasteless - a demo merchant's name (the mild cafe)
    "\u7981",   # 禁 - restrict, prohibit, forbid - a demo merchant's name (no pets)
    "\u79aa",   # 禪 - meditation, contemplation (dhyana); to level ground for altar; abdicate - a demo merchant's name (sushi zen)
    "\u7ba1",   # 管 - pipe, tube, duct; woodwind music - an injection payload
    "\u8c27",   # 谧 - calm, quiet, still; cautious - a demo merchant's name (the quiet cafe)
    "\u8d0a",   # 贊 - help, support, assist, aid - a sponsored label the test supplies
    "\u91ce",   # 野 - open country, field; wilderness - a Cantonese place name in the resolution table
    "\u9760",   # 靠 - lean on, trust, depend on; near - the query that asks for a nearby place
    "\u9805",   # 項 - neck, nape of neck; sum; funds - a corpus line (the full menu)
    "\u9ebc",   # 麼 - interrogative final particle; insignificant, small, tiny - the merchant agent's question
}


def _data_strings(path: Path) -> list[str]:
    """The string constants of a module - its DATA, not its prose.

    A docstring is prose: it describes the code, it does not answer anything, and the
    prose of a module is not a vocabulary. The comments are not constants at all.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    except SyntaxError:  # pragma: no cover - a file that does not parse is not ours
        return []
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef,
                                 ast.ClassDef)) or not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                and isinstance(first.value.value, str):
            docstrings.add(id(first.value))
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and id(node) not in docstrings]


def _reference_characters() -> set[str]:
    """Every Chinese character the product itself carries.

    DERIVED from the package, so the reference cannot go stale: a new vocabulary table,
    a new template, a new label - all of them are in the reference the moment they
    exist. The evaluation package is excluded: the suite being judged cannot define what
    the judge knows (that would be circular).
    """
    known: set[str] = set()
    for path in sorted(PACKAGE.rglob("*.py")):
        if "eval" in path.parts:
            continue
        for text in _data_strings(path):
            for ch in text:
                if "\u4e00" <= ch <= "\u9fff":
                    known.add(ch)
    return known


def _unknown_characters(texts: list[tuple[str, str]]) -> dict[str, list[str]]:
    """The Chinese characters that neither the product nor DECLARED knows."""
    known = _reference_characters()
    unknown: dict[str, list[str]] = {}
    for where, text in texts:
        for ch in text:
            if "\u4e00" <= ch <= "\u9fff" and ch not in known and ch not in DECLARED:
                unknown.setdefault(ch, [])
                if where not in unknown[ch]:
                    unknown[ch].append(where)
    return unknown


def test_the_intent_cases_use_characters_the_product_knows():
    texts: list[tuple[str, str]] = []
    path = DATA / "intent_v1.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        texts.append((str(case.get("id")), canonical(str(case.get("query") or ""))))
    unknown = _unknown_characters(texts)
    assert not unknown, (
        "the evaluation's intent cases use Chinese characters the product's vocabulary "
        "does not carry - each one is a word the platform has never heard of, so the case "
        "asserts something that is not the behaviour under test: "
        + ", ".join(f"U+{ord(ch):04X} ({', '.join(where)})"
                    for ch, where in unknown.items()))


def test_every_test_file_uses_characters_the_product_knows():
    # D453: the wrong code point hides in the test files, not in the case files - and the
    # scope here is the WHOLE directory, not the paths somebody remembered (D452).
    texts: list[tuple[str, str]] = []
    for path in sorted(TESTS.glob("*.py")):
        for text in _data_strings(path):
            texts.append((path.name, text))
    unknown = _unknown_characters(texts)
    assert not unknown, (
        "these test files use Chinese characters the product's vocabulary does not carry: "
        "a hand-written code point is not a reference (D409, D446), and a test that uses "
        "a character nobody knows is asserting a word the platform has never heard of - "
        + ", ".join(f"U+{ord(ch):04X} ({', '.join(where)})"
                    for ch, where in unknown.items()))


def test_no_test_file_carries_a_byte_order_mark():
    # D453: a BOM is invisible in the source and breaks every reader that opens the file
    # as plain UTF-8 - the gate above included, until the mark was taken out.
    marked = [path.name for path in sorted(TESTS.glob("*.py"))
              if path.read_bytes().startswith(b"\xef\xbb\xbf")]
    assert not marked, (
        "these test files start with a UTF-8 byte order mark, so a plain-UTF-8 reader "
        "cannot read them: " + ", ".join(marked))
