"""D580 - the interpreter that runs this suite was itself unbootable, and nothing said so.

`uv sync` writes `apps/ai/.venv/.../site-packages/_editable_impl_nexus_ai.pth` holding the
repository's OWN absolute path, and Python's site handling opens every `.pth` with the
interpreter's LOCALE encoding. On the machine this project is developed on the path is
not ASCII and the locale is cp936, so the decode failed and the interpreter died before it
could read a single line of code:

    UnicodeDecodeError: 'gbk' codec can't decode byte 0xae in position 7

Measured, that closed the whole local path at once: `uv run pytest`, `python -m pytest`,
`uv run uvicorn` and `python -c "import nexus_ai"` all died at startup, so `make unit` could not
begin and no gate in this file could run. `PYTHONUTF8=1` and `-X utf8` do not change which
encoding site.py uses for a `.pth`, so this is not a knob anyone can turn; and CI runs on Linux,
where the locale is UTF-8, so no CI job could see the machine being broken either. A suite that
cannot start is not a suite, and a gate that only holds on one platform's encoding is not a gate
on the other.

`scripts/repair_ai_editable_path.py` is the cure: it moves the recorded paths into a UTF-8 side
file that an importer module reads with an EXPLICIT encoding, leaving the `.pth` pure ASCII. What
this door owes:

  * the repair driven on a synthetic tree, so the byte-level rule is proved on every platform and
    not only where the machine happens to be broken. The script's criterion is the interpreter's
    own locale, which on Linux can never fail on a UTF-8 path - so the drive names the encoding it
    is pretending to be, and the row means the same thing on both platforms.
  * a `.pth` that already reads is left untouched, because `make unit` / `make test` /
    `make dev-ai` / `make ai-embed` run the repair on every invocation, and a "fix" that rewrites a
    healthy install is a new way to break it.
  * the two facts that were false, on the interpreter running this test: it can read every `.pth`
    it will be handed, and `nexus_ai` came from the tree these tests sit in.
"""

from __future__ import annotations

import locale
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "repair_ai_editable_path.py"
SIDECAR = "nexus_editable_paths.txt"
IMPORTER = "nexus_editable_paths"

#: a project directory whose name no ASCII locale can read. Spelled with the escapes D453 asks
#: for, and with two characters the product's own vocabulary carries, so the door that keeps a
#: test from asserting a word nobody knows does not have to make an exception for this one.
NON_ASCII = "\u9910\u5ef3"

#: the encoding the synthetic drives pretend the interpreter has. ASCII is the one name every
#: platform's Python answers, and no non-ASCII path survives it, so the broken-install rows
#: mean what they say on Linux as much as on the machine the defect was measured on.
UNREADABLE = "ascii"


def _site_pth_dirs() -> list[Path]:
    """Every site-packages this interpreter actually reads its `.pth` files from."""
    return [Path(p) for p in sys.path if p.endswith("site-packages") and Path(p).is_dir()]


def _run(venv: Path, *extra: str, encoding: str | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(SCRIPT), "--venv", str(venv), *extra]
    if encoding:
        cmd += ["--locale-encoding", encoding]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          cwd=str(REPO_ROOT), env={**os.environ, "PYTHONUTF8": "1"},
                          check=False)


def _broken_tree(tmp_path: Path) -> tuple[Path, Path]:
    """A venv whose `.pth` records a path the judged locale cannot read."""
    site = tmp_path / "Lib" / "site-packages"
    site.mkdir(parents=True)
    project = tmp_path / NON_ASCII / "apps" / "ai"
    project.mkdir(parents=True)
    (site / "_editable_impl_nexus_ai.pth").write_bytes((str(project) + "\n").encode("utf-8"))
    return tmp_path, project


def _lines(path: Path) -> list[str]:
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_the_repair_moves_a_path_the_locale_cannot_read(tmp_path: Path) -> None:
    """The byte-level rule, driven on a tree built to be broken."""
    venv, project = _broken_tree(tmp_path)
    pth = venv / "Lib" / "site-packages" / "_editable_impl_nexus_ai.pth"
    result = _run(venv, encoding=UNREADABLE)
    assert result.returncode == 0, f"the repair exited {result.returncode}: {result.stderr}"
    assert _lines(pth), f"{pth} was emptied"
    try:
        pth.read_bytes().decode("ascii")
    except UnicodeDecodeError as exc:
        pytest.fail(f"the repaired .pth still holds bytes a locale cannot take: {exc}")
    assert all(line.startswith("import ") for line in _lines(pth)), (
        f"{_lines(pth)}: site.py executes an `import` line and appends a path line - a path line "
        f"is the byte that broke the boot, so none may stay")
    assert (pth.parent / SIDECAR).exists(), "the paths went nowhere - no side file was written"
    assert project in [Path(line) for line in _lines(pth.parent / SIDECAR)], (
        f"the side file holds {_lines(pth.parent / SIDECAR)}, not the {project} the .pth recorded")
    assert (pth.parent / f"{IMPORTER}.py").exists(), (
        "the .pth imports a module that was never written")


def test_the_repaired_importer_installs_the_path_it_moved(tmp_path: Path) -> None:
    """The cure proved by an interpreter reaching the package, not by the file it wrote.

    site.py executes an `.pth` line that starts with `import`, in a namespace whose path holds
    that site directory; the child below is the same two steps, and the question is the one that
    was failing: does the package directory reach `sys.path` when the locale could never decode
    it?
    """
    venv, project = _broken_tree(tmp_path)
    site = venv / "Lib" / "site-packages"
    _run(venv, encoding=UNREADABLE)
    (project / "d580_probe.py").write_text("MARKER = 1\n", encoding="utf-8")
    script = (f"import sys; sys.path.insert(0, {str(site)!r}); "
              f"import {IMPORTER}; import d580_probe; print(d580_probe.MARKER)")
    result = subprocess.run([sys.executable, "-E", "-S", "-c", script],
                            capture_output=True, text=True, encoding="utf-8", check=False,
                            env={**os.environ, "PYTHONUTF8": "1"})
    assert "1" in result.stdout, (
        f"the importer did not let an interpreter reach {project}: {result.stderr or result.stdout}")


def test_a_pth_the_locale_can_read_is_left_alone(tmp_path: Path) -> None:
    """These recipes run the repair on every invocation; it must not touch a healthy install."""
    site = tmp_path / "Lib" / "site-packages"
    site.mkdir(parents=True)
    pth = site / "healthy.pth"
    pth.write_text("../elsewhere\nimport something\n", encoding="utf-8")
    before = pth.read_bytes()
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr
    assert pth.read_bytes() == before, "a readable .pth was rewritten"
    assert not (site / SIDECAR).exists(), "a side file appeared for a path that needed no moving"
    assert "REPAIRED" not in result.stdout, result.stdout


def test_a_tree_with_no_venv_is_not_an_error(tmp_path: Path) -> None:
    """`make unit` runs this before anyone has created a venv; that is not a failure to report."""
    result = _run(tmp_path / "absent-venv")
    assert result.returncode == 0, (
        f"a machine with no venv made every AI recipe fail: "
        f"{result.returncode} {result.stdout} {result.stderr}")


def test_the_check_mode_names_the_file_and_changes_nothing(tmp_path: Path) -> None:
    """--check is what a setup run uses to certify the install, so it must not repair quietly."""
    venv, _project = _broken_tree(tmp_path)
    pth = venv / "Lib" / "site-packages" / "_editable_impl_nexus_ai.pth"
    before = pth.read_bytes()
    result = _run(venv, "--check", encoding=UNREADABLE)
    assert result.returncode == 1, f"--check passed on a .pth the locale cannot read: {result.stdout}"
    assert pth.read_bytes() == before, "--check wrote the file it was told only to report"
    assert pth.name in result.stdout, f"the report did not name the file it refused: {result.stdout}"


def test_the_repair_is_idempotent(tmp_path: Path) -> None:
    """The second run must find nothing to do, or a `make unit` loop rewrites the install."""
    venv, _project = _broken_tree(tmp_path)
    first = _run(venv, encoding=UNREADABLE)
    assert first.returncode == 0, first.stderr
    pth = venv / "Lib" / "site-packages" / "_editable_impl_nexus_ai.pth"
    after_first = pth.read_bytes()
    second = _run(venv, encoding=UNREADABLE)
    assert second.returncode == 0, second.stderr
    assert pth.read_bytes() == after_first, "the second run changed the .pth again"
    assert "REPAIRED" not in second.stdout, second.stdout


#: every `.pth` this interpreter will be handed at startup, as it will be handed it.
SHIP_PTHS = sorted({p for d in _site_pth_dirs() for p in d.glob("*.pth")})


@pytest.mark.parametrize("pth", SHIP_PTHS, ids=[str(p) for p in SHIP_PTHS])
def test_this_interpreter_can_read_every_pth_it_will_be_handed(pth: Path) -> None:
    """The fact that was false, read on the interpreter that is running this suite right now.

    site.py opens a `.pth` with the locale encoding, so that is the decode tried here - a file
    this reader can read and the interpreter cannot is exactly the D580 shape.
    """
    encoding = locale.getpreferredencoding(False)
    data = pth.read_bytes()
    try:
        data.decode(encoding)
    except UnicodeDecodeError as exc:
        pytest.fail(f"{pth} cannot be decoded by this interpreter's locale encoding "
                    f"{encoding!r} ({exc}) - the venv will not boot. Run "
                    f"`python {SCRIPT.name}`; the Makefile runs it for `make unit`, `make test`, "
                    f"`make dev-ai` and `make ai-embed`.")


def test_the_tests_are_running_against_this_tree_not_an_installed_copy() -> None:
    """The other half of the same boot: the path the `.pth` carried had to reach the package.

    Read off the module that was imported, not off `sys.path`, because a path entry pointing at a
    directory is not the same claim as the package these tests actually got.
    """
    import nexus_ai

    resolved = Path(nexus_ai.__file__).resolve()
    assert resolved.is_relative_to((REPO_ROOT / "apps" / "ai").resolve()), (
        f"nexus_ai was imported from {resolved}, outside this tree - the tests are certifying an "
        f"installed copy rather than the code under review")


def test_the_shipped_venv_boots_through_the_repair_it_needs() -> None:
    """The machine's own install, judged the way a setup run judges it."""
    venv = REPO_ROOT / "apps" / "ai" / ".venv"
    if not venv.is_dir():
        pytest.skip(f"no venv at {venv} - run `make ai-install` to build the install this "
                    f"door certifies")
    result = _run(venv, "--check")
    assert result.returncode == 0, (
        f"{venv} holds a .pth this interpreter cannot read: {result.stdout}{result.stderr}")


def test_the_door_reaches_a_real_pth_or_the_install_is_absent() -> None:
    """The parametrised rows are worthless if no `.pth` was found to read.

    On a machine where this package was imported the plain way (no editable install, so no
    `.pth`) the population is honestly empty and the floor says which half of the door is dark.
    """
    assert SHIP_PTHS or not any((d / "nexus_ai-0.1.0.dist-info").is_dir() for d in _site_pth_dirs()), (
        "this interpreter reads an editable install of nexus_ai but the door found no .pth to "
        "decode - the rows above were vacuous")
