"""Regenerate `apps/ai/nexus_ai/models/atlas_index.txt` — the chapter-lane table of contents.

The chapter-ask lane (nexus_ai.api.routes_chapter) grounds every reader question in
the real world: the model sees the whole arc's chronology before answering about ONE
chapter. The digest script (gen_atlas_digest.py) is the single source of truth for
chapter order and clock/scene — this script reads the frozen digest and re-emits ONLY
the chapter lines under a chapter-lane fence. No hand edits; byte-stable on purpose
(prefix cache). Run `apps/ai/gen_atlas_digest.py` first, then this script.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "nexus_ai" / "models" / "atlas_digest.txt"
DST = ROOT / "nexus_ai" / "models" / "atlas_index.txt"

HEADER = """# THE HONG KONG ARC — CHAPTER INDEX (chapter-lane grounding)
# Every chapter of the arc, in order. Use it to place this chapter inside the world.
# The arc is synthetic narrative; merchants and people are fictional; the arc is flags:{demo:true}
"""


def main() -> None:
    digest = SRC.read_text(encoding="utf-8")
    lines = [ln for ln in digest.splitlines() if re.match(r"^\s*\d+ ·", ln)]
    if len(lines) < 100:
        raise SystemExit(f"atlas_index: only {len(lines)} chapter lines found in the digest — run gen_atlas_digest.py first")
    DST.write_text(HEADER + "\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"atlas_index regenerated: {len(lines)} chapters · {DST.stat().st_size} bytes")


if __name__ == "__main__":
    main()
