"""D588 - a preference kind the ranker reads is one the shipped API accepts.

Three planes spell the preference vocabulary and only two of them are consulted when a user
writes. Measured at the head this unit was cut against:

* the ranking branch table in `search/service.py` has a clause for **13** kinds - `access`,
  `ambience`, `budget`, `cuisine`, `food`, `location`, `occasion`, `price_sense`, `style`,
  `time_pref`, `view`, `weakness`, `weather`;
* `MeController.PreferenceBody`'s `@Pattern` and `packages/types`' `PREFERENCE_KIND` - the
  validator and the contract, which carry the same list - allow **8**: `food`, `budget`,
  `location`, `brand`, `style`, `activity`, `language`, `accessibility`.

The intersection is four. Nine kinds the ranker honours cannot be created through
`POST /api/v1/me/preferences` at all: the caller is refused before a row exists, so the
memory the product reads is a memory the product cannot be told about. The D527 door already
caught the same fault line from the other side (a declared row the ranker had no branch for)
and fixed the seed's spelling; nobody fixed the API's.

`access` is the sharpest of the nine because the seed writes it: `data/seed/generate.py`'s own
`prefs` list declares `("access", "accessible", ...)`, and the live plane carries the row. The
platform stores a kind its own write validator refuses, so the preference that demo users have
is one their owner cannot edit or re-create (§32/§33: preferences are user-visible, editable,
deletable).

The mirror direction is recorded rather than quietly kept. Three accepted words have no
ranking clause: `activity` and `brand` have never had a reader, and `accessibility` is the
sharper debt - it is the contract's own word for a step-free preference while the ranker and
the seed both spell it `access`, so a caller who obeys the published types stores a row that
nothing answers for. Retiring those three would refuse callers that work today, so this unit
only adds, and the alias question is filed in PLAN rather than answered by a second spelling
in the reader (D545: one value, one lane).

**Arms.** Each rewrites one shipped copy of the vocabulary - or this door's own reader - runs the
door, and puts the file back byte-identically (`restored=True` on all four). The names below are
what the run printed, not what was expected:

* B4, the state change: both write lists reverted to the eight words they carried before this
  unit - **11 failed, 7 passed**. Nine `..._created_through_the_api[<kind>]` rows (`access`,
  `ambience`, `cuisine`, `occasion`, `price_sense`, `time_pref`, `view`, `weakness`, `weather`),
  `test_the_seed_declares_only_kinds_the_api_accepts`, and the live
  `test_the_plane_stores_only_kinds_the_api_accepts`. That is the red this unit was cut against
  and the green the shipped tree now holds.
* B1, `weakness` dropped from the Java `@Pattern` alone - **2 failed**: that parametrised row AND
  `test_the_validator_and_the_contract_name_the_same_kinds`. A validator falling behind the
  contract is caught twice, once as an unfillable promise and once as a split list.
* B2, `access` dropped from `PREFERENCE_KIND` alone - **1 failed**, the agreement row only. The
  writable claim reads the server, not the types package, so a contract that under-states the
  server moves exactly one row - and that row is why the two write planes are compared to each
  other and not only to the reader.
* B3, this door's reader of the branch table blinded (`sub.left.id == "kind"` renamed) - **2
  failed, 3 passed, 1 skipped**: the census guard and the residue row. Blinding it does not just
  empty the census, it drops every kind out of the parametrised promise, so nine rows would go
  quietly green with nothing behind them. The guard is what stops that reading as a pass.

"""

from __future__ import annotations

import ast
import asyncio
import os
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_SERVICE = _ROOT / "apps" / "ai" / "nexus_ai" / "search" / "service.py"
_JAVA = _ROOT / "services" / "platform" / "src" / "main" / "java" / "com" / "nexus" \
    / "identity" / "MeController.java"
_TS = _ROOT / "packages" / "types" / "src" / "enums.ts"
_SEED = _ROOT / "data" / "seed" / "generate.py"

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

#: Accepted by the write planes and not a ranking signal. `language/response_locale` says
#: which language to answer in - the exemption D527's door already names.
DISPLAY_ONLY = {"language"}


def _readable_kinds() -> set[str]:
    """Every kind the ranking branch table has a clause for, read off the source with `ast`.

    The same technique D527's gate uses for (kind, key) pairs: reading the table rather than
    importing it means a branch written five minutes ago is in the census, and a branch
    deleted is no longer counted as promised.
    """
    tree = ast.parse(_SERVICE.read_text(encoding="utf-8"))
    kinds: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        for sub in ast.walk(node.test):
            if not (isinstance(sub, ast.Compare) and len(sub.ops) == 1):
                continue
            if isinstance(sub.left, ast.Name) and sub.left.id == "kind":
                comparator = sub.comparators[0]
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    kinds.add(comparator.value)
    return kinds


def _java_kinds() -> set[str]:
    """The list `PreferenceBody`'s kind validator actually admits.

    Read off the annotation VALUE, not one line: the pattern is a string expression and a lane
    that wraps it into `"a|b" + "|c|d"` is still one validator, so the reader joins the literals
    before splitting them. An annotation the reader cannot find is the failure this row raises -
    a write vocabulary nobody censuses is the thing that made this unit necessary.
    """
    text = _JAVA.read_text(encoding="utf-8")
    start = text.find("public record PreferenceBody")
    assert start >= 0, (
        "PreferenceBody is gone from MeController.java - the DTO this gate censuses is no "
        "longer where the write vocabulary lives")
    # Anchored on the record, not on the file: `@Pattern(regexp = ` appears in several bodies,
    # and a reader that starts at the first one in the file joins two validators into a list
    # that names nothing.
    match = re.search(r'@Pattern\(regexp\s*=\s*(?P<expr>.*?)\)\s*String kind',
                      text[start:], re.DOTALL)
    assert match, (
        "PreferenceBody's kind @Pattern is no longer the shape this gate reads - the write "
        "vocabulary has moved to somewhere nobody censuses")
    expr = "".join(re.findall(r'"([^"]*)"', match.group("expr")))
    expr = expr.strip().removeprefix("^").removesuffix("$")
    if expr.startswith("(") and expr.endswith(")"):
        expr = expr[1:-1]
    return {k.strip() for k in expr.split("|") if k.strip()}


def _ts_kinds() -> set[str]:
    """The list the contract names."""
    text = _TS.read_text(encoding="utf-8")
    match = re.search(r"PREFERENCE_KIND = \[(?P<list>[^\]]*)\]", text)
    assert match, "PREFERENCE_KIND is no longer a plain array literal - the gate must be re-read"
    return set(re.findall(r'"([^"]+)"', match.group("list")))


def _seed_kinds() -> set[str]:
    """Every kind the seed declares for the demo consumer."""
    tree = ast.parse(_SEED.read_text(encoding="utf-8"))
    holder = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "prefs" for t in node.targets):
            holder = node.value
            break
    assert isinstance(holder, ast.List), "the seed's `prefs` list is no longer a list literal"
    kinds: set[str] = set()
    for element in holder.elts:
        assert isinstance(element, ast.Tuple) and element.elts, "a prefs row is not a tuple"
        first = element.elts[0]
        assert isinstance(first, ast.Constant), "a prefs row's kind is not a literal"
        kinds.add(str(first.value))
    return kinds


READABLE = _readable_kinds()
WRITABLE = _java_kinds()
CONTRACT = _ts_kinds()
DECLARED = _seed_kinds()


class TestTheWriteVocabularyIsOneList:
    def test_the_validator_and_the_contract_name_the_same_kinds(self):
        assert WRITABLE == CONTRACT, (
            f"the Java validator admits {sorted(WRITABLE - CONTRACT)} that the contract does "
            f"not name, and the contract names {sorted(CONTRACT - WRITABLE)} the validator "
            f"refuses - a client coded to the types package can be refused by the server it "
            f"calls")

    def test_the_gate_reads_every_plane_it_claims_to_compare(self):
        # A gate whose regex matched nothing would pass every row below it.
        assert len(READABLE) >= 12, f"the branch table census answered {sorted(READABLE)}"
        assert len(WRITABLE) >= 8, f"the Java pattern census answered {sorted(WRITABLE)}"
        assert len(CONTRACT) >= 8, f"the contract census answered {sorted(CONTRACT)}"
        assert len(DECLARED) >= 6, f"the seed census answered {sorted(DECLARED)}"


class TestTheRankerVocabularyIsWritable:
    @pytest.mark.parametrize("kind", sorted(READABLE), ids=sorted(READABLE))
    def test_a_kind_the_ranker_reads_can_be_created_through_the_api(self, kind):
        assert kind in WRITABLE, (
            f"the ranking table has a clause for kind={kind!r} and POST /api/v1/me/"
            f"preferences refuses the word before a row exists - the user cannot tell the "
            f"product something the product is built to honour")

    def test_the_seed_declares_only_kinds_the_api_accepts(self):
        refused = sorted(DECLARED - WRITABLE)
        assert not refused, (
            f"the seed writes {refused} for the demo consumer while the shipped validator "
            f"would refuse the same word - the platform's own data is a shape its own API "
            f"cannot produce, so the owner cannot edit or re-create it (§32/§33)")


@live_only
def test_the_plane_stores_only_kinds_the_api_accepts():
    """The stored rows, not the source: a plane may hold kinds the validator later refused."""
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def _go():
        settings = Settings(llm_provider="mock", embedding_provider="hashing",
                            database_url=DB_URL, internal_token="0" * 8)
        db = await db_pool.connect(settings, force_new=True)
        try:
            return await db.readonly(
                "select kind, count(*) as n from user_preferences group by kind order by kind")
        finally:
            await db_pool.dispose()

    rows = asyncio.run(_go())
    assert rows, "no preference rows on this plane - the census has nothing to judge"
    stored = {str(r["kind"]) for r in rows}
    refused = sorted(stored - WRITABLE)
    assert not refused, (
        f"this plane stores {refused} ({rows}) which the shipped write validator refuses - "
        f"rows the owner can see and cannot rewrite")


class TestWhatTheWritePlanesAcceptThatNothingReads:
    """Recorded, not fixed: refusing them now would break callers that work today."""

    def test_the_unread_writable_kinds_are_the_ones_named_here(self):
        unread = sorted(WRITABLE - READABLE - DISPLAY_ONLY)
        assert unread == ["accessibility", "activity", "brand"], (
            f"the write planes accept {unread} that the ranker has no clause for. Each is a "
            f"different debt and this row is the census that keeps them visible: "
            f"`accessibility` is the trap - the API's own word for a step-free preference, "
            f"while the reader and the seed spell it `access`, so a caller who obeys the "
            f"contract stores a row nothing answers for; `activity` and `brand` have never "
            f"had a reader. Either a clause appeared (fold it into the census above) or the "
            f"vocabulary grew a word nobody answers")
