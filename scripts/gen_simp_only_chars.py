#!/usr/bin/env python3
"""D1534 — generate the simplified-only character set the zh-HK script census charges against.

Why this file exists. `check_ui_script.mjs` derives its character knowledge from
`nexus_ai/nlu/canonical.py` (239 pairs) and `nexus_ai/nlu/lexicon.py` (144 pairs). Those tables
were built to fold search queries, not to audit a corpus — so the census knew 239 of the ~4,000
characters that exist only in Simplified. Measured on 2026-11-22: the reader was PASSING over a
dict.ts literal reading 两空開始读下去, catching 两 only because `两` happened to be one of the
239, and staying silent on 读 — one line, three simplified characters, one flag. A gate that
recognises 6% of the alphabet it claims to police is not a gate; it is a sample.

The source. opencc-python-reimplemented ships `dictionary/TSCharacters.txt`, the Traditional ->
Simplified character table. A character is "simplified-only" when it appears somewhere on the
right-hand side but never on the left: it is a form Traditional text does not use. Characters
that are both (台, 面, 干, 里) appear on both sides and are correctly NOT charged — they are
Traditional characters that a fold happens to produce, and the product writes them for real.

Written by a script, never by hand: the D1533 lesson is that Chinese written through an editing
pipeline arrives with mangled codepoints. Here every byte comes out of opencc's own data, so the
only thing this generator can get wrong is its own arithmetic — which `--check` re-derives.

Usage:
  python scripts/gen_simp_only_chars.py           # write scripts/data/simp-only-chars.txt
  python scripts/gen_simp_only_chars.py --check   # exit 1 if the file is stale or unreadable
"""
from __future__ import annotations

import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "data" / "simp-only-chars.txt"

HEADER = """\
# D1534 — characters that exist ONLY in Simplified Chinese.
#
# Derived from opencc-python-reimplemented, by the only rule that does not over-report: a character
# is charged when opencc's own `s2t` pass would CHANGE it, and it is not itself a source form in
# `dictionary/TSCharacters.txt`. The naive rule — "appears on the right of TSCharacters but never on
# the left" — was tried first and charged 2真教向出表系了回, because rare variants like 眞 fold DOWN
# to the standard modern form 真, which both scripts use. A character that survives s2t unchanged is
# a character Traditional text has use for, whatever the table's shape suggests.
#
# The residue is the known ambiguity class, where the Simplified form is ALSO a real Traditional
# character for a different word: 台 (platform, vs 臺), 干 (to interfere, vs 幹), 里 (village unit,
# vs 裏), 后 (queen, vs 後). Those are named and measured in `check_ui_script.mjs`'s EXCLUSIONS —
# an exclusion with a reason and a count, never a silent skip.
#
# This file supplements `nexus_ai/nlu/canonical.py` + `lexicon.py` in `check_ui_script.mjs`. Those
# tables carry 383 pairs and were built to fold search queries; the real inventory is ~3,900.
# Regenerate with:  python scripts/gen_simp_only_chars.py
#
# One character per line after the header, in codepoint order. Never hand-edit.
"""


def build() -> list[str]:
    try:
        import opencc  # type: ignore[import-not-found]
    except ImportError:
        return []
    root = Path(opencc.__file__).resolve().parent
    table = root / "dictionary" / "TSCharacters.txt"
    if not table.exists():
        return []
    try:
        fold = opencc.OpenCC("s2t")
    except Exception:  # noqa: BLE001 - a fold that cannot be built is a plane we cannot judge
        return []

    sources: set[str] = set()
    candidates: set[str] = set()
    for line in table.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        sources.add(parts[0])
        candidates.update(parts[1:])

    charged: list[str] = []
    for ch in sorted(candidates):
        if len(ch) != 1 or ch in sources:
            continue
        try:
            if fold.convert(ch) == ch:
                continue
        except Exception:  # noqa: BLE001 - an unfoldable glyph is not evidence of a Simplified form
            continue
        charged.append(ch)
    return charged


def render(chars: list[str]) -> str:
    return HEADER + "".join(f"{ch}\n" for ch in chars)


def main(argv: list[str]) -> int:
    chars = build()
    if not chars:
        print("RESULT: NOT CHECKED — opencc or its TSCharacters table is unavailable; nothing written")
        return 2
    body = render(chars)
    if "--check" in argv:
        if not OUT.exists():
            print(f"RESULT: FAIL — {OUT.relative_to(OUT.parents[2])} is missing; run without --check")
            return 1
        if OUT.read_text(encoding="utf-8") != body:
            print("RESULT: FAIL — simp-only-chars.txt no longer matches opencc's own table")
            return 1
        print(f"RESULT: PASS — {len(chars)} simplified-only characters, byte-identical to opencc's table")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(OUT.parents[2])}: {len(chars)} simplified-only characters")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
