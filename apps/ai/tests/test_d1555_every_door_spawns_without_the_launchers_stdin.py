"""D1555 - a door that spawns must not inherit whatever the test runner left in file descriptor 0.

The AI suite is the project's gate, and on this machine it stopped being one: `pytest -q` in `apps/ai` aborted
during COLLECTION with

    tests/test_no_card_repeats_a_value_pointer_inside_a_closed_block.py:81: in <module>
        TRACKED = _tracked_root()
    ...
    C:\\...\\Lib\\subprocess.py:1431: in _make_inheritable
        h = _winapi.DuplicateHandle(...)
    E   OSError: [WinError 6] The handle is invalid.

and the run reported `1 error in 23.40s` - no test verdicts at all (`tmp/d1555_suite_abort.txt`). Nothing about the
repository was broken: the module-level `subprocess.run([...], capture_output=True)` asks Python to hand the
child the PARENT's stdin, and while pytest is capturing output fd 0 is a temporary file that has already been
closed, so the handle it duplicates is invalid. The same spawn without pytest in front of it succeeds
(`tmp/d1555_probe.txt`), and the same spawn with `stdin=subprocess.DEVNULL` succeeds under pytest - which is
why D1550's own door only started passing once `_decide()` pinned the keyword.

The consequence is the reason this is a gate and not a footnote: an aborting collection is not a red test, it
is NO tests. Every other door in the lane is silenced by one unpinned spawn, and a lane whose suite cannot
start is a lane whose suite says nothing. It is also launcher-independent in the direction that matters - the
fix is one keyword, so the gate stops depending on whether the runner happens to leave a usable fd 0.

The census (`tmp/d1555_stdin_census.txt`, run by the same balanced-paren scan this file uses) found
**9 spawn sites in 6 files** of `apps/ai/tests` with no `stdin=`: this file's own predecessor plus
`test_a_subject_with_no_reviews_prints_no_rating_score.py`, `test_d1549_unit_lane_pins_the_proxy_env.py`,
`test_prefix_contract_is_byte_stable.py`,
`test_the_card_sends_no_ranking_internal_the_closed_contract_refuses.py` and
`test_the_local_interpreter_can_read_its_editable_install.py`. All nine are probes that read no console, so
pinning is the whole repair.

R1 scans the tree and carries a coverage floor: if it sees no spawn anywhere it reddens, because a glob that
stopped matching would otherwise read as "all clean" (that is what `tmp/d1555_arms.py` ARM 5 found, and the
floor is what it added). R2 unit-tests the scanner itself — a call written across lines still has to be seen,
`stdin=subprocess.DEVNULL` still has not to be reported, and `stdin=None` has to be reported, since re-asking
for the parent's fd 0 is the defect rather than a spelling of the fix. R3 re-checks the premise so the gate
cannot pass because the lane deleted the door it was written for.
"""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

TESTS = Path(__file__).resolve().parent
SPAWN = re.compile(r"subprocess\.(?:run|Popen|check_output|check_call|getoutput)\s*\(")


def _is_pinned(call: str) -> bool:
    """`stdin=` decides, but `stdin=None` re-asks for the parent's handle, which is the defect."""
    return "stdin=" in call and re.search(r"stdin\s*=\s*None\s*[,)]", call) is None


def _call_text(text: str, open_paren: int) -> str:
    """The balanced `(...)` argument list starting at `open_paren`, strings ignored."""
    depth, i, quote = 0, open_paren, None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren:i + 1]
        i += 1
    return text[open_paren:]


def unpinned_spawns(path: Path) -> list[tuple[int, str]]:
    """(line, call excerpt) for every `subprocess.*(...)` in this file that does not pin `stdin`.

    The excerpt keeps the call's END as well as its start: whether the offender reads `stdin=None` or has no
    keyword at all is the difference between a half-fix and no fix, and a head-only excerpt hides it.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    out = []
    for m in SPAWN.finditer(text):
        call = _call_text(text, m.end() - 1)
        if not _is_pinned(call):
            one = " ".join(call.split())
            excerpt = one if len(one) <= 110 else f"{one[:70]} ... {one[-45:]}"
            out.append((text[:m.start()].count("\n") + 1, excerpt))
    return out


class TestEveryDoorSpawnsWithoutTheLaunchersStdin:
    def test_r1_no_spawn_in_the_tests_tree_leaves_stdin_to_the_runner(self):
        offenders, spawners = [], []
        for path in sorted(TESTS.glob("*.py")):
            if path.name == Path(__file__).name:
                continue                                   # this door scans, it does not spawn
            if SPAWN.search(path.read_text(encoding="utf-8", errors="replace")):
                spawners.append(path.name)
            for line, head in unpinned_spawns(path):
                offenders.append(f"{path.name}:{line} {head}")
        assert spawners, (
            "the scan saw no subprocess call anywhere in the tests tree - either the lane stopped spawning "
            "probes (then this gate is dead weight and should say so) or the scan stopped seeing them, which "
            "is the failure ARM 5 of tmp/d1555_arms.py reproduces: a glob that matches nothing passes green")
        assert not offenders, (
            "these subprocess calls inherit the runner's stdin, and while pytest is capturing output that "
            f"handle is invalid: {offenders}. Pass stdin=subprocess.DEVNULL - see "
            "tests/test_d1555_every_door_spawns_without_the_launchers_stdin.py")

    def test_r2_the_scan_still_sees_a_spawn_written_across_lines(self):
        """Without this leg `SPAWN` could degrade to a single-line regex and R1 would read as 'all clean'
        on exactly the multi-line calls the census found — and the `stdin=None` half is what ARM 2 of
        `tmp/d1555_arms.py` reddened first: a keyword that re-asks for the parent's handle is not a pin."""
        sample = ('x = subprocess.run(\n    ["git", "rev-parse"],\n'
                  '    capture_output=True, text=True)\n')
        assert len(unpinned_spawns(_scratch(sample))) == 1, "the multi-line call was not seen at all"
        devnull = sample.replace("text=True)", "text=True, stdin=subprocess.DEVNULL)")
        assert unpinned_spawns(_scratch(devnull)) == [], "a pinned call still reported as unpinned"
        ask_again = sample.replace("text=True)", "text=True, stdin=None)")
        assert len(unpinned_spawns(_scratch(ask_again))) == 1, (
            "`stdin=None` accepted as a pin: it asks for the parent's fd 0, which is the defect itself")

    def test_r3_the_aborting_door_is_still_here_and_still_scanned(self):
        """The premise, re-checked: the file whose module-level probe aborted collection is present, spawns,
        and is covered - so this gate cannot pass because the lane deleted the door it was meant to fix."""
        path = TESTS / "test_no_card_repeats_a_value_pointer_inside_a_closed_block.py"
        assert path.exists(), f"{path.name} is gone - re-read D668/D669 before closing this unit"
        assert SPAWN.search(path.read_text(encoding="utf-8", errors="replace")), (
            "the premise file no longer spawns; this leg's claim moved")
        assert not unpinned_spawns(path), f"{path.name} still has an unpinned spawn"


def _scratch(text: str) -> Path:
    f = Path(tempfile.mkdtemp()) / "scratch_sample.py"
    f.write_text(text, encoding="utf-8")
    return f
