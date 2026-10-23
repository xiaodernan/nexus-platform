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

D542 added the third half of the rule. Both exemption tables are consulted BEFORE the
name is looked for, so a declared name that becomes real stays invisible to the very
rule written to catch it: `embed.py` was declared as the platform's importer while
`apps/ai/nexus_ai/rag/embed.py` had been in the repository for weeks and `docs/RAG.md`
names it as the lane's own Embed and Store stage. A declaration is a claim, so each one
is now held to what it says, and a name borrowed from outside the repository has to
resolve to a file the interpreter can produce here and now.
"""

from __future__ import annotations

import importlib.util
import re
import sys
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
#:
#: D542 charged this table. It is an exemption, and an exemption is checked BEFORE the
#: name is looked for, so a name that becomes real stays invisible to the rule that was
#: written to catch it: `embed.py` was declared as the platform's importer while
#: `apps/ai/nexus_ai/rag/embed.py` had been in the repository for weeks and the RAG
#: documents name it as the lane's own pipeline stage. Every entry is now held to what it
#: claims - see the three clauses under `# --- the declarations are claims too`.
DECLARED_PROMISES = {
    "ingest.py": "the platform's importer parses the merchant's documents (not in this repo)",
    "chunk.py": "the platform's importer chunks them (not in this repo)",
    "orchestrator/planner.py": "the orchestrator is not built yet (AGENTS.md's promise)",
    "apps/ai/nexus_ai/orchestrator/planner.py": (
        "the orchestrator is not built yet (AGENTS.md's promise)"),
    "apps/ai/nexus_ai/tools/registry.py": (
        "the tool registry is not built yet (AGENTS.md's promise)"),
}

#: The names a document borrows from OUTSIDE this repository - a file that is real, just
#: not here, so the reader must not be sent to a repo path for it. Each value is the import
#: name the document means, and the clause below refuses the exemption until the
#: interpreter resolves that name to a file that is not under the repository root.
#:
#: `ENVIRONMENT_REPORT.md` names CPython's own startup module to explain a host hazard: the
#: venv's `.pth` files are read by `site.py` with the LOCALE encoding, which is what kills
#: every interpreter launch under a path the GBK codepage cannot decode. The name is a fact
#: about the machine, not a promise about this repository, and a flat "not here" exemption
#: would have let either kind rot silently.
DECLARED_EXTERNAL = {
    "site.py": "site",
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
        if raw in DECLARED_PROMISES or raw in DECLARED_EXTERNAL:
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


# ------------------------------------------------------- the declarations are claims too
#: The `origin` sentinels `importlib` uses for a module that has no source file of its own.
_RESERVED_ORIGINS = ("frozen", "built-in")


def _judged_docs() -> list[Path]:
    """The documents this file grades - the ledgers excepted, as every rule here does."""
    return [d for d in sorted(DOCS.glob("*.md")) if d.name not in LEDGERS]


def _cited_names() -> set[str]:
    """Every module name a judged document puts in backticks, read the way the rules read."""
    out: set[str] = set()
    for doc in _judged_docs():
        for match in MODULE.finditer(doc.read_text(encoding="utf-8")):
            out.add(match.group(1).rstrip(".,;)"))
    return out


def _interpreter_file(import_name: str) -> str | None:
    """Where THIS interpreter keeps the module, or None when it has no file to show.

    A frozen module answers `'frozen'` for `spec.origin` and keeps its real path on the
    already-imported module, so both places are read before the name is called unresolved.
    """
    try:
        spec = importlib.util.find_spec(import_name)
    except (ImportError, ValueError):
        spec = None
    origin = getattr(spec, "origin", None) if spec else None
    if origin and origin not in _RESERVED_ORIGINS and Path(origin).is_file():
        return origin
    module = sys.modules.get(import_name)
    origin = getattr(module, "__file__", None) if module else None
    return origin if origin and Path(origin).is_file() else None


def test_a_declaration_names_no_file_the_repository_has():
    """Neither table may exempt a name that the repository in fact holds.

    The exemption is consulted before the name is looked for, so a declared promise that
    gets built stays invisible to the very rule written to catch it: `embed.py` was filed
    as the platform importer while `apps/ai/nexus_ai/rag/embed.py` had been here for
    weeks, and `docs/RAG.md` names it as the lane's own Embed and Store rows.
    """
    by_name = _by_name()
    built = [f"{table}: {raw} -> {by_name[Path(raw).name][0]}"
             for table, names in (("DECLARED_PROMISES", DECLARED_PROMISES),
                                  ("DECLARED_EXTERNAL", DECLARED_EXTERNAL))
             for raw in sorted(names) if Path(raw).name in by_name]
    assert not built, (
        "these names are exempted as not-in-this-repo while the repository has them - the "
        "documents' claim is false, or the exemption is dead and the rule cannot see the "
        "drift any more: " + "; ".join(built))


def test_every_declaration_is_still_cited_by_a_document():
    """A declaration with no citation is a hiding place, not an exemption.

    Both tables let a name out of the census. If no judged document ever names it again,
    the entry is left over from a sentence that was rewritten, and it will keep exempting
    whatever reader adds that name back to a document.
    """
    dead = sorted(({*DECLARED_PROMISES, *DECLARED_EXTERNAL}) - _cited_names())
    assert not dead, (
        "these declared names are cited by no document this file judges - delete the "
        "exemption, or restore the sentence it belongs to: " + "; ".join(dead))


def test_a_borrowed_name_resolves_outside_the_repository():
    """`DECLARED_EXTERNAL` may only hold a name the interpreter can actually produce.

    The claim is stronger than "not in this repo": the reader is told the file is real,
    just elsewhere. So the import name has to resolve to a file here and now, and that
    file has to sit outside the repository root - a name that resolves to nothing is a
    promise wearing the other table, and one that resolves into the repo is a drift.
    """
    for raw, import_name in sorted(DECLARED_EXTERNAL.items()):
        found = _interpreter_file(import_name)
        assert found is not None, (
            f"{raw!r} is declared as a real file outside this repository, but this "
            f"interpreter does not resolve the import name {import_name!r} to any file - "
            f"say which machine it is a fact about, or move it to DECLARED_PROMISES")
        resolved = Path(found)
        assert not resolved.is_relative_to(REPO), (
            f"{raw!r} resolves to {resolved}, which is inside the repository - the "
            f"document is naming a file of this lane's, not the interpreter's")

