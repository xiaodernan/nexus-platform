#!/usr/bin/env python3
"""Make the AI venv boot on a machine whose locale encoding cannot read its editable install.

`uv sync` writes `apps/ai/.venv/.../site-packages/_editable_impl_nexus_ai.pth` holding the
repository's own absolute path. Python's site handling opens every `.pth` with the interpreter's
LOCALE encoding, so when that path is not ASCII (a Chinese directory name) and the locale is not
UTF-8 (Windows + gbk) the interpreter dies before it can run anything at all:

    UnicodeDecodeError: 'gbk' codec can't decode byte 0xae in position 7

Measured on this machine: `uv run pytest`, `python -m pytest`, `uv run uvicorn` and even
`python -c "import nexus_ai"` all died that way, so the whole local test and dev path was closed
- and CI on Linux, where the locale is UTF-8, cannot see it. `PYTHONUTF8=1` and `-X utf8` do not
change which encoding site.py uses for a `.pth`, so no environment knob fixes it: the file has to
stop carrying those bytes.

This script rewrites an offending `.pth` as an ASCII `import` line and moves the paths it recorded
into a UTF-8 side file that the importer module reads with an EXPLICIT encoding. It is idempotent,
touches only a `.pth` that cannot be decoded under the locale encoding (a healthy venv is left
alone and says nothing, because the recipes below run this on every invocation), and imports
nothing from the project, so it runs under any interpreter - including a
system one, which is the only kind available while the venv is broken.

    python scripts/repair_ai_editable_path.py            # repair
    python scripts/repair_ai_editable_path.py --check    # report, change nothing, exit 1

`make unit`, `make test`, `make dev-ai` and `make ai-embed` run it first; D579's door
`apps/ai/tests/test_the_local_interpreter_can_read_its_editable_install.py` is what says so.
"""

from __future__ import annotations

import argparse
import glob
import locale
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VENV = os.path.join(REPO_ROOT, "apps", "ai", ".venv")
IMPORTER = "nexus_editable_paths"
SIDECAR = "nexus_editable_paths.txt"

#: Written into site-packages by hand, so the bytes here are the only copy of the rule.
IMPORTER_SOURCE = '''\
"""Install the paths a `.pth` could not carry - written by scripts/repair_ai_editable_path.py.

Python opens a `.pth` with the interpreter's LOCALE encoding, so a `.pth` that holds a
non-ASCII path closes the interpreter on a machine whose locale is not UTF-8. The path moved
to the UTF-8 side file below, which this module reads with an explicit encoding, and the
`.pth` became the ASCII import line that reached this file.
"""

import os
import sys

_SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nexus_editable_paths.txt")


def _install():
    if not os.path.exists(_SIDECAR):
        return
    with open(_SIDECAR, "r", encoding="utf-8") as handle:
        for line in handle.read().splitlines():
            path = line.strip()
            if path and os.path.isdir(path) and path not in sys.path:
                sys.path.append(path)


_install()
'''


def site_packages(venv: str) -> list[str]:
    """Every site-packages the venv could have on this platform (Lib on Windows, lib/pyX on POSIX)."""
    patterns = (os.path.join(venv, "Lib", "site-packages"),
                os.path.join(venv, "lib", "python*", "site-packages"))
    found: list[str] = []
    for pattern in patterns:
        found.extend(p for p in glob.glob(pattern) if os.path.isdir(p))
    return found


def _decodable(data: bytes, encoding: str) -> bool:
    try:
        data.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return False
    return True


def _rewrite(pth: str, encoding: str, apply: bool) -> str:
    """One sentence per file: what is wrong with it and what the repair writes."""
    with open(pth, "rb") as handle:
        data = handle.read()
    if _decodable(data, encoding):
        return ""
    paths = [line.strip() for line in data.decode("utf-8", "replace").splitlines()
             if line.strip() and not line.strip().startswith("import ")]
    imports = [line.strip() for line in data.decode("utf-8", "replace").splitlines()
               if line.strip().startswith("import ")]
    if not paths:
        return f"{pth} is undecodable but records no path - nothing to move"
    if not apply:
        return (f"{pth} cannot be read by this interpreter ({encoding}): it records {paths} "
                f"- repair would move them to {SIDECAR}")
    sidecar = os.path.join(os.path.dirname(pth), SIDECAR)
    existing: list[str] = []
    if os.path.exists(sidecar):
        with open(sidecar, "r", encoding="utf-8") as handle:
            existing = [line.strip() for line in handle.read().splitlines() if line.strip()]
    merged = list(dict.fromkeys([*existing, *paths]))
    with open(sidecar, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("".join(p + "\n" for p in merged))
    with open(os.path.join(os.path.dirname(pth), IMPORTER + ".py"),
              "w", encoding="utf-8", newline="\n") as handle:
        handle.write(IMPORTER_SOURCE)
    lines = [line for line in imports if _decodable(line.encode("utf-8"), encoding)]
    if f"import {IMPORTER}" not in lines:
        lines.append(f"import {IMPORTER}")
    with open(pth, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("".join(line + "\n" for line in lines))
    return f"{os.path.basename(pth)}: moved {paths} into {SIDECAR}, the file is now ASCII"


def run(venv: str, check: bool, encoding: str) -> tuple[int, int]:
    """(the files needing the repair, the files repaired)."""
    bad = fixed = 0
    for root in site_packages(venv):
        for pth in sorted(glob.glob(os.path.join(root, "*.pth"))):
            message = _rewrite(pth, encoding, apply=not check)
            if not message:
                continue
            bad += 1
            if check:
                print(f"NEEDS REPAIR  {message}")
            else:
                fixed += 1
                print(f"REPAIRED      {message}")
    if bad and check:
        return bad, fixed
    if not bad and check:
        print(f"OK            every .pth in {venv} is readable under {encoding}")
    return bad, fixed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--venv", default=DEFAULT_VENV, help="the AI virtualenv (default apps/ai/.venv)")
    parser.add_argument("--check", action="store_true", help="report only, write nothing")
    # D580: the criterion is the interpreter's OWN locale encoding, so a door that wants to
    # witness a broken install has to be able to name one. Linux CI reads a UTF-8 path under a
    # UTF-8 locale and could never make the file undecodable by writing it; `--locale-encoding
    # ascii` says "this interpreter cannot read the path", which is the machine state the unit
    # was written for, on every platform. Nothing in the recipes passes it.
    parser.add_argument("--locale-encoding", default=None,
                        help="judge the .pth against this encoding instead of the interpreter's")
    args = parser.parse_args(argv)
    encoding = args.locale_encoding or locale.getpreferredencoding(False)
    if not os.path.isdir(args.venv):
        print(f"SKIP          no virtualenv at {args.venv} - nothing to repair")
        return 0
    bad, fixed = run(args.venv, args.check, encoding)
    if args.check and bad:
        print(f"!! {bad} .pth file(s) this interpreter cannot read; run "
              f"`python scripts/repair_ai_editable_path.py`")
        return 1
    if fixed:
        print(f"the AI venv boots again ({fixed} file(s) rewritten)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
