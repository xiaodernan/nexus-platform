"""D441 - the docs' paths to the AI lane's own files must be paths a reader can open.

The lane's documents name files the reader is expected to open: the router, the state
merger, the search SQL. Those names had drifted - the docs say `apps/ai/app/...` and the
repository says `apps/ai/nexus_ai/...` - so a reader (or an agent) who followed the path
found nothing, and the document that was supposed to point at the implementation pointed
at a layout that was never built.

The rule this file applies, and the reason it is not simply "every path must exist":

  * a path that exists -> fine;
  * a path that does not exist but the SAME FILE exists elsewhere -> STALE, and that is
    the defect (the reader follows it and finds nothing);
  * a path that does not exist and has no counterpart -> a promise about the future
    (the tool registry, the orchestrator), which is a promise, not a drift.

The ledgers are history: their entries record what was true when they were written, and a
record is not rewritten to look tidier than it was.
"""

from __future__ import annotations

import re
from pathlib import Path

#: The repository root: the first parent that holds `data/seed/generate.py`.
def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "seed" / "generate.py").exists():
            return parent
    raise AssertionError("the repository root was not found from this file")


REPO = _repo_root()
DOCS = REPO / "docs"

#: The ledgers are history - their paths are what was true when the entry was written.
LEDGERS = frozenset({"STATUS.md", "DECISIONS.md"})

#: A repo path in backticks.
PATH = re.compile(r"`((?:apps|packages|services|infra|scripts|data|tests|docs)/[A-Za-z0-9_./-]+)`")


def _by_tail() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for path in REPO.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            rel = path.relative_to(REPO).as_posix()
            out.setdefault("/".join(rel.split("/")[-2:]), []).append(rel)
    return out


def _stale_paths(doc: Path, by_tail: dict[str, list[str]]) -> list[tuple[str, str]]:
    stale: list[tuple[str, str]] = []
    for match in PATH.finditer(doc.read_text(encoding="utf-8")):
        raw = match.group(1).rstrip(".,;)")
        if not raw.startswith("apps/ai/"):
            continue  # another lane's file
        if (REPO / raw).exists():
            continue
        if (REPO / "apps" / "ai" / raw).exists():
            continue  # the shorthand the docs use for the lane's own tests
        tail = "/".join(raw.split("/")[-2:])
        elsewhere = [p for p in by_tail.get(tail, []) if p != raw]
        if elsewhere:
            stale.append((raw, elsewhere[0]))
    return stale


def test_the_ai_lane_s_documents_name_paths_that_exist():
    by_tail = _by_tail()
    stale: list[tuple[str, str, str]] = []
    for doc in sorted(DOCS.glob("*.md")):
        if doc.name in LEDGERS:
            continue
        for raw, real in _stale_paths(doc, by_tail):
            stale.append((doc.name, raw, real))
    assert not stale, (
        "these documents name a file at a path that does not exist, while the file itself "
        "is here - a reader who follows the path finds nothing: "
        + "; ".join(f"{doc}: {raw} -> {real}" for doc, raw, real in stale))
