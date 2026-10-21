"""D441/D462 - the docs' paths to the AI lane's own files must be paths a reader can open.

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

D462 added the second half of the rule. That rule only ever saw a path that CARRIES A
DIRECTORY, so a bare module name - `pack.py`, `ingest.py` - was never checked at all, and
the documents named eleven modules that exist nowhere: three of them were renames (the
file moved and the name stayed behind) and the rest were the RAG pipeline's table and the
orchestrator's promise.

The ledgers are history: their entries record what was true when the entry was written, and
a record is not rewritten to look tidier than it was.
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

#: A module name in backticks - with or without a directory. D462: the rule above only
#: ever saw a path that carries a directory, so a bare `pack.py` was invisible to it.
MODULE = re.compile(r"`([A-Za-z0-9_./-]*[A-Za-z0-9_]+\.py)`")

#: The module names the documents promise and the repository does not have. Each one says
#: what it is, so a reader who follows it knows what to expect.
DECLARED_PROMISES = {
    "ingest.py": "the platform's importer parses the merchant's documents (not in this repo)",
    "chunk.py": "the platform's importer chunks them (not in this repo)",
    "embed.py": "the platform's importer embeds them (not in this repo)",
    "orchestrator/planner.py": "the orchestrator is not built yet (AGENTS.md's promise)",
    "apps/ai/nexus_ai/orchestrator/planner.py": (
        "the orchestrator is not built yet (AGENTS.md's promise)"),
    "apps/ai/nexus_ai/tools/registry.py": (
        "the tool registry is not built yet (AGENTS.md's promise)"),
}


def _is_noise(path: Path) -> bool:
    """The places a name is NOT a fact about this repository."""
    if ".git" in path.parts or ".venv" in path.parts:
        return True
    return "site-packages" in path.parts or "node_modules" in path.parts


def _by_tail() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for path in REPO.rglob("*"):
        if not path.is_file() or _is_noise(path):
            continue
        rel = path.relative_to(REPO).as_posix()
        out.setdefault("/".join(rel.split("/")[-2:]), []).append(rel)
    return out


def _by_name() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for path in REPO.rglob("*"):
        if not path.is_file() or _is_noise(path):
            continue
        out.setdefault(path.name, []).append(path.relative_to(REPO).as_posix())
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


def _missing_modules(doc: Path, by_name: dict[str, list[str]]) -> list[str]:
    """The module names the document names that are in no file anywhere."""
    missing: list[str] = []
    for match in MODULE.finditer(doc.read_text(encoding="utf-8")):
        raw = match.group(1).rstrip(".,;)")
        if raw in DECLARED_PROMISES:
            continue
        if raw in by_name or Path(raw).name in by_name:
            continue
        missing.append(raw)
    return missing


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


def test_the_documents_name_modules_that_exist():
    # D462: a bare module name is not a path, so the rule above never saw it - and the
    # documents named eleven modules that exist nowhere. A name that exists NOWHERE is a
    # promise, and a promise has to be declared; a name that exists somewhere but is not
    # where the document says is a drift, and the D441 rule above catches that.
    by_name = _by_name()
    missing: list[str] = []
    for doc in sorted(DOCS.glob("*.md")):
        if doc.name in LEDGERS:
            continue
        for raw in _missing_modules(doc, by_name):
            missing.append(f"{doc.name}: {raw}")
    assert not missing, (
        "these documents name a module that exists nowhere in the repository - a reader "
        "who follows the name finds nothing, and a name that is not there at all is a "
        "promise that has to be declared: " + "; ".join(missing))
