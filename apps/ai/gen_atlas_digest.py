"""Regenerate `apps/ai/nexus_ai/models/atlas_digest.txt` — the frozen world bible.

The world-guide lane (nexus_ai.orchestrator.world_guide_graph) grounds its phrasing in the
real arc. The digest is a compact, deterministic snapshot of the published corpus: one line
per chapter — index · clock · scene — plus the world constitution. It is BACKGROUND for the
model, never a menu: the model still chooses only between the two curated doors.

PROVENANCE — this script generated the committed artifact from the source of truth
(`apps/web/src/lib/mock/seed.ts`), which carries all 133 chapters with their three arms.

If you add a chapter:
    python apps/ai/gen_atlas_digest.py
(and re-review the digest diff — it must only append the new lines). Never hand-edit the
artifact; it is byte-stable on purpose: the world guide's prompt cache is a prefix cache.

No runtime dependencies; safe to run locally. Does not touch Simplified folds (web props).
"""
from __future__ import annotations

import io
import re

ROOT = r"D:/获客平台"
SRC = ROOT + r"/apps/web/src/lib/mock/seed.ts"
DST = ROOT + r"/apps/ai/nexus_ai/models/atlas_digest.txt"

HEADER = """# THE HONG KONG ARC · 香港系列 · THE SYNTHETIC WORLD
# 00:00→23:00+ · {total} chapters · three arms (zh-HK Traditional / zh-CN opencc fold / full English prose)
# demo:true · every scene is narrative construction; merchants and people are fictional; the arc is flags:{demo:true}
# Layers A–M CLOSED · Layer N CLOSED at ch.138 (the afternoon last count) · Layer O CLOSED at ch.144 (after the meet) · Layer P open (the east gate, D1450)
# World constitution:
#   · the arc is one long Hong Kong day told in {words} rooms
#   · each chapter is a single shopfront, crossing or dawn queue — a place you can almost touch
#   · characters reappear across layers (the cash register never lies; dragon-gate, Octopus, the harbour)
#   · money is counted, lamps are lit, ledgers close before notices — no drama without a witness
#   · the arc is synthetic narrative, never travel advice; every merchant is fictional
# The atlas is BACKGROUND ONLY: it exists so your phrasing sounds like the world that actually exists.
# Never name a place beyond the two doors you are given. Never quote a chapter number.
"""

NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

SLUG_OVERRIDE = {
    "hk-food-chronicle": 1,
    "hk-tung-chung-chronicle": 34,
    "hk-peng-chau-chronicle": 35,
    "hk-north-run-chronicle": 36,
    "hk-tai-o-chronicle": 37,
}


def parse_cn(s: str) -> int:
    total, cur = 0, 0
    if s.startswith("百"):
        total, s = 100, s[1:]
    for ch in s:
        if ch == "零":
            continue
        if ch == "十":
            cur = (cur * 10) if cur else 10
        elif ch == "百":
            total += (cur if cur else 1) * 100
            cur = 0
        else:
            v = NUM.get(ch)
            if v is None:
                return -1
            if cur == 0:
                cur = v
            elif cur < 10:
                cur = cur * 10 + v
            else:
                cur = cur + v
    return total + cur


def chapter_no(title: str) -> int:
    m = re.search(r"第([一二三四五六七八九十百零]+)章", title)
    return parse_cn(m.group(1)) if m else -1


def _cn_words(n: int) -> str:
    """English words for small integers in the constitution header (e.g. 147 → 'one hundred and forty-seven')."""
    ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
    tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

    def two(x: int) -> str:
        if x < 10:
            return ones[x]
        if x < 20:
            return teens[x - 10]
        t, o = divmod(x, 10)
        return tens[t] + ("-" + ones[o] if o else "")

    if n < 100:
        return two(n)
    h, rest = divmod(n, 100)
    return two(h) + " hundred" + (" and " + two(rest) if rest else "")


def main() -> None:
    s = io.open(SRC, encoding="utf-8").read()
    entries: dict[int, tuple[str, str]] = {}
    for m in re.finditer(r"slug:\s*'([^']+)',\s*title:\s*'([^']+)'", s):
        slug, title = m.group(1), m.group(2)
        if slug in SLUG_OVERRIDE:
            no = SLUG_OVERRIDE[slug]
        elif "香港系列" not in title:
            continue
        else:
            no = chapter_no(title)
        if no <= 0 or no in entries:
            continue
        if "：" in title:
            clock = title.split("：", 1)[0].strip()
            scene = title.split("：", 1)[1].split("（")[0].strip()
        else:
            clock, scene = "", title.split("（")[0].strip()
        entries[no] = (clock, scene)
    total = max(entries)
    missing = [n for n in range(1, total + 1) if n not in entries]
    if missing:
        raise SystemExit(f"missing chapters: {missing}")
    words = _cn_words(total)
    header = HEADER.replace("{total}", str(total)).replace("{words}", words)
    lines = [f"{no:3d} · {clock} · {scene}" for no, (clock, scene) in sorted(entries.items())]
    io.open(DST, "w", encoding="utf-8", newline="\n").write(header + "\n".join(lines) + "\n")
    print(f"atlas_digest regenerated: {total} chapters · {len(io.open(DST,'rb').read())} bytes")


if __name__ == "__main__":
    main()
