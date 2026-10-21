"""The vocabulary is the reference for a CJK code point.

D409 was a defect that did not exist: the probe spelled 餐廳 with the wrong code point
(U+5EF6, which is 延 - "to delay"), the probe matched nothing, and the "fix" made the
vocabulary match the probe's typo. D414 withdrew it, and D416/D417 rebuilt the vocabulary
against the Unihan database.

The lesson is that a hand-written CJK code point is not a reference, and this test is
the reference the repo can carry without shipping the Unihan data: **a character the
product's own vocabulary knows is a character the product can answer for.** A case file
that uses a character nobody knows is a case file asserting a word the platform has never
heard of - and it fails for a reason that has nothing to do with the behaviour under
test.

So: every Chinese character in the evaluation's INTENT cases must be one the lexicon,
the canonical table or the merge's cues already carry - after the canonicalisation, which
is what the product actually does with the text.

It is not a gate the cases could have been written to pass: writing it found THREE wrong
code points in the evaluation's own price case (什 for 咩, 麼 for 啲, and a variant of
啲), and the case had been PASSING - because the single-character cue 平 fired on its own,
so the case was not testing the phrase it claimed to test.

The injection suite is deliberately NOT in the scope: its payloads are ATTACKS, and an
attack is supposed to use words the platform has never heard of.
"""

from __future__ import annotations

import json
from pathlib import Path

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "nexus_ai" / "eval" / "data"

#: The characters the cases use that the vocabulary does not carry, DECLARED - each one
#: verified against the Unihan database, because that is the whole point:
#:
#:   U+54A9 咩   the Cantonese question particle ("有咩平啲嘅")
#:   U+5605 嘅   the Cantonese possessive
#:   U+684C 桌   a table ("訂枱")
#:   U+9002 适   the simplified 適 ("適合")
#:   U+5408 合   to fit ("適合")
#:   U+516D 六   six ("周六")
#:   U+6211 我   I ("幫我找")
#:
#: They are grammatical words, and the words that do the work in each query are the ones
#: the vocabulary knows.
DECLARED = {
    "\u54a9",   # 咩 - the Cantonese question particle
    "\u5605",   # 嘅 - the Cantonese possessive
    "\u684c",   # 桌 - a table
    "\u9002",   # 适 - the simplified 適
    "\u5408",   # 合 - to fit
    "\u516d",   # 六 - six
    "\u6211",   # 我 - I
}


def _known_characters() -> set[str]:
    """Every Chinese character the product's vocabulary already carries."""
    known: set[str] = set()

    def take(table) -> None:
        for ch in repr(table):
            if "\u4e00" <= ch <= "\u9fff":
                known.add(ch)

    take(L.CATEGORY_SYNONYMS)
    take(L.CUISINE_TERMS)
    take(L.SORT_RULES)
    take(L.CONSTRAINT_RULES)
    take(L.CONSTRAINT_CANON)
    take(getattr(L, "DISTRICTS", {}))
    take(getattr(L, "PREFERENCE_RULES", []))
    take(getattr(L, "PREFERENCE_CUES", {}))
    take(getattr(L, "PREFERENCE_RULE_VALUES", []))
    take(getattr(L, "COMPARE_CUES", []))
    take(getattr(L, "DISCOVER_CUES", []))
    take(getattr(L, "RESERVE_CUES", []))
    take(getattr(L, "PURCHASE_CUES", []))
    take(getattr(L, "ASK_MERCHANT_CUES", []))
    take(getattr(L, "PLAN_CUES", []))
    take(getattr(L, "NEARBY_TERMS", []))
    take(getattr(L, "OPEN_PRICE_WORDS", []))
    take(M.CHEAPER_CUES)
    take(M.PRICIER_CUES)
    take(M.NEARER_CUES)
    take(M.FARTHER_CUES)
    take(M.QUIET_CUES)
    take(M.LOUDP_CUES)
    take(M.ALT_CUES)
    take(M.OPEN_NOW_CUES)
    take(M.ANYTIME_CUES)
    for ch, canon in CANONICAL_FORMS.items():
        known.add(ch)
        known.add(canon)
    return known


def test_the_intent_cases_use_characters_the_vocabulary_knows():
    known = _known_characters()
    unknown: dict[str, list[str]] = {}
    path = DATA / "intent_v1.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        for ch in canonical(str(case.get("query") or "")):
            if "\u4e00" <= ch <= "\u9fff" and ch not in known and ch not in DECLARED:
                unknown.setdefault(ch, []).append(str(case.get("id")))
    assert not unknown, (
        "the evaluation's intent cases use Chinese characters the product's vocabulary does "
        "not carry - each one is a word the platform has never heard of, so the case "
        "asserts something that is not the behaviour under test: "
        + ", ".join(f"U+{ord(ch):04X} ({', '.join(where)})"
                    for ch, where in unknown.items()))
