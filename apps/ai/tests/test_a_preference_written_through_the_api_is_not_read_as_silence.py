"""D587 - the strength the shipped API writes by default is not the strength the ranker ignores.

The write plane and the read plane each held one number, and nobody had compared them.

`IdentityRepository.upsertPreference` bound `weight == null ? 0.5 : weight`, and the column is
`NOT NULL DEFAULT 0.500` (`infra/db/migrations/V1__init.sql:67`), so a caller who declared a
preference and said nothing about its strength got 0.5. In the ranker that is not a weak signal:
every matcher reflects a weight around 0.5 (D527), so the DISTANCE from neutral carries the
strength and 0.5 carries none. Measured on the fixture lane, one candidate, the same query, with
the preference row present at 0.5, present at this write plane's default, or absent entirely -
final score for the merchant that satisfies the preference, and for the one that does not:

    branch                    satisfies                  does not satisfy
                  no row    w=0.5    w=0.7      no row    w=0.5    w=0.7
    access/accessible       0.493735  0.493735  0.505735  0.493735  0.493735  0.481735
    view/scenic             0.493735  0.493735  0.505735  0.493735  0.493735  0.481735
    style/ambience          0.493735  0.493735  0.505735  0.493735  0.493735  0.493735
    time_pref/open_late     0.493735  0.493735  0.505735  0.493735  0.493735  0.481735
    weather/rainy_day       0.493735  0.493735  0.505735  0.493735  0.493735  0.481735
    budget/per_person_max_hkd 0.493735 0.493735 0.505735  0.522603  0.522603  0.510603
    location/home_district  0.493735  0.493735  0.505735  0.493735  0.493735  0.493735

Fourteen pairs, and in all fourteen the `no row` and `w=0.5` columns are equal to the last
decimal. To the last decimal, a preference written at 0.5 answers what the same merchant answers
for a user who never said anything. §32 promises the preference is remembered and shown to its
owner - and it was, and it was used for nothing. The caller's silence had been recorded as a
claim of neutrality, which is the one thing the ranker cannot tell apart from having no data.

At 0.7 the same fourteen cells split: every branch lifts the merchant that satisfies the user by
0.012000, five push the one that does not down by the same, and two (`style/ambience`,
`location/home_district`) leave it exactly where silence leaves it - the assertion this gate
keeps is therefore the DIRECTION of each side's delta, not which candidate wins the page. Which
candidate wins could not be a claim anyway: the budget pair's two merchants differ in price, and
price is read by signals other than the preference, so the expensive one starts 0.028868 ABOVE
the cheap one (0.522603 vs 0.493735) and stays above it after the preference fires.

This gate reads the number out of the Java file and hands it to the ranker, so the two planes
cannot drift apart again without somebody answering for it:

* `DECLARED_PREFERENCE_WEIGHT` must not equal `NEUTRAL_PREFERENCE_WEIGHT` - stated directly,
  because "the default is not the dead point" is the whole unit;
* at the neutral point the score must be the score of NO ROW AT ALL, for every preference the
  ranker has a branch for - that is what makes 0.5 the dead point rather than a mild one;
* at the write plane's default the merchant the user asked for must beat the one they did not,
  and must score differently from silence - the preference now changes an answer;
* the default must sit inside the band the platform's own demo data declares, so the number is
  a statement about this product's users rather than a constant nobody can see reflected anywhere.

The write behaviour itself - the floor on a new row, and silence no longer resetting a strength
the owner had stated - is walked against the shipped API by
`services/platform/src/test/java/com/nexus/identity/PreferenceWeightDoorTest.java`; this file
carries only what the ranker side of the same number can show.

**Arms**, each mutating one shipped number or this door's own reader and restoring byte-for-byte
(`restored=True` both times). The counts are what the runs printed:

* A - `DECLARED_PREFERENCE_WEIGHT` back to the 0.5 the write plane shipped: **8 failed, 9
  passed** - the inequality row and all seven delta rows. This arm IS the pre-fix state, and it
  names the cost: seven preferences stored, listed and used for nothing.
  `test_the_gate_reads_both_planes` stayed GREEN under it, because 0.5 sits inside the band the
  seed's own declared rows occupy - the band row keeps the default a statement about these users,
  it is not the gate for this defect.
* C - the Java constant renamed so the reader cannot find it: **1 error during collection**, the
  door's own assert, no row run. A reader that fell back to a guessed number would keep promising
  an answer while comparing against a value nothing wrote.
* B and D walk the write side (the `coalesce`, and the shipped default) and are measured in the
  Java door named above.
"""

from __future__ import annotations

import ast
import asyncio
import json
import re
from pathlib import Path

import pytest

import nexus_ai.search.service as S

_ROOT = Path(__file__).resolve().parents[3]
_REPO = _ROOT / "services" / "platform" / "src" / "main" / "java" / "com" / "nexus" \
    / "identity" / "IdentityRepository.java"
_SEED = _ROOT / "data" / "seed" / "generate.py"

#: The ranker's no-evidence point is 0.5 by D527's own construction; the Java name is what the
#: write plane is allowed to use for it, and the first row below says they are not the same number.
NEUTRAL_POINT = 0.5


def _java_constant(name: str) -> float:
    text = _REPO.read_text(encoding="utf-8")
    match = re.search(rf"double\s+{name}\s*=\s*([0-9.]+)\s*;", text)
    assert match, (
        f"{name} is no longer a plain double literal in IdentityRepository.java - the number "
        f"this gate holds the ranker to has moved somewhere nobody reads")
    return float(match.group(1))


DECLARED_DEFAULT = _java_constant("DECLARED_PREFERENCE_WEIGHT")


def _seed_declared_weights() -> list[float]:
    """Every strength the demo corpus itself declares for its consumer."""
    tree = ast.parse(_SEED.read_text(encoding="utf-8"))
    holder = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "prefs" for t in node.targets):
            holder = node.value
            break
    assert isinstance(holder, ast.List), "the seed's `prefs` list is no longer a list literal"
    out: list[float] = []
    for element in holder.elts:
        assert isinstance(element, ast.Tuple) and len(element.elts) >= 5, \
            "a prefs row is not the (kind, key, value, weight, source) shape this gate reads"
        weight, source = element.elts[3], element.elts[4]
        assert isinstance(weight, ast.Constant) and isinstance(source, ast.Constant), \
            "a prefs row's weight or source is no longer a literal"
        if str(source.value) == "declared":
            out.append(float(weight.value))
    assert out, "the seed declares no weighted preference at all - this census has nothing to say"
    return out


class _Backend(S.StaticBackend):
    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [dict(p) for p in self.prefs if str(p.get("user_id")) == user_id]


#: Every live row carries a non-empty `attributes` JSONB (measured: 0 of 470 published merchants
#: and 0 of 4,707 active offerings answer empty or NULL), and the stored-preference layer is
#: gated on exactly that - `merchant_attrs` is filled only by the `if attrs and mid not in
#: merchant_attrs` guard in `search/service.py`, so a candidate with an empty JSONB never reaches
#: `_enriched_attrs`, and its own price and district are invisible to the budget and location
#: branches. The fixture keeps the shape the plane has so this gate measures the product and not
#: the artifact; the shape question itself has its own row below and is filed in PLAN.
_LIVE_JSONB = {"outdoor_seating": False}


def _row(*, attrs=None, price=None, district=None, live_shape=True):
    """`live_shape=False` is the one door the recorded shape question needs: a bare JSONB."""
    return {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
            "display_name": "Test Place", "display_name_zh": "測試場所",
            "category_primary": "Cafe", "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": price if price is not None else 100,
            "district": district or "central",
            "tags": ["coffee"],
            "attributes": {**_LIVE_JSONB, **(attrs or {})} if live_shape else dict(attrs or {}),
            "kw_score": 0.5, "text_matched": True}


def _score(kind, key, value, weight, **row_kw):
    """The final score one candidate gets from one preference row - `weight=None` writes no row."""
    async def go():
        backend = _Backend(merchants=[_row(**row_kw)])
        backend.prefs = [] if weight is None else [
            {"user_id": "u1", "kind": kind, "key": key, "value": json.dumps({"value": value}),
             "weight": weight, "source": "declared", "scope": "long_term"}]
        plan = S.SearchPlan(query_text="place", limit=10)
        _cards, _resp, _bundle, scored = await S.search(backend=backend, plan=plan, user_id="u1")
        return float(scored[0].score)

    return asyncio.run(go())


#: (kind, key, value, the candidate that SATISFIES it, the candidate that does NOT) - the same
#: table D527's door walks, plus the two non-boolean branches the API can write.
PREFERENCES = [
    ("access", "accessible", True,
     {"attrs": {"accessible_access": True, "wheelchair_access": True}},
     {"attrs": {"accessible_access": False, "wheelchair_access": False}}),
    ("view", "scenic", True, {"attrs": {"scenic_view": True}}, {"attrs": {"scenic_view": False}}),
    ("style", "ambience", "quiet",
     {"attrs": {"quiet_ambience": True}}, {"attrs": {"quiet_ambience": False}}),
    ("time_pref", "open_late", True,
     {"attrs": {"opens_late": True}}, {"attrs": {"opens_late": False}}),
    ("weather", "rainy_day", True,
     {"attrs": {"indoor_style": True}}, {"attrs": {"outdoor_style": True}}),
    ("budget", "per_person_max_hkd", 200, {"price": 100}, {"price": 400}),
    ("location", "home_district", "central", {"district": "central"},
     {"district": "sha-tin"}),
]

_IDS = [f"{kind}/{key}" for kind, key, _v, _y, _n in PREFERENCES]


def test_the_write_default_is_not_the_reads_dead_point():
    """The identity of these two numbers IS the defect, so it is stated as one inequality."""
    assert DECLARED_DEFAULT != NEUTRAL_POINT, (
        "the rows below prove the ranker reads 0.5 as no evidence at all; a write plane that "
        "stamps 0.5 for a caller who said nothing therefore stores a preference that answers "
        "nothing")
    assert 0.0 < DECLARED_DEFAULT <= 1.0, (
        "the column is numeric(4,3) over 0..1 and the API validates DecimalMin/Max - a default "
        "outside the range is a row the write plane cannot land")


def test_the_gate_reads_both_planes():
    """A gate whose reader answered nothing would pass every row below it."""
    assert len(PREFERENCES) >= 6, f"the preference table this gate walks shrank to {_IDS}"
    weights = _seed_declared_weights()
    assert min(weights) <= DECLARED_DEFAULT <= max(weights), (
        f"the write plane's default {DECLARED_DEFAULT} sits outside the band the platform's own "
        f"demo data declares {sorted(weights)} - the number stopped being a statement about "
        f"these users and became a constant nobody can see reflected anywhere")


@pytest.mark.parametrize("kind,key,value,yes,no", PREFERENCES, ids=_IDS)
def test_at_the_dead_point_a_preference_answers_what_no_preference_answers(
        kind, key, value, yes, no):
    """What makes 0.5 the dead point: not a weak signal, the absence of one."""
    for side, row_kw in (("satisfies", yes), ("does not", no)):
        silence = _score(kind, key, value, None, **row_kw)
        at_neutral = _score(kind, key, value, NEUTRAL_POINT, **row_kw)
        assert at_neutral == pytest.approx(silence), (
            f"{kind}/{key}={value!r} at weight 0.5 scores the merchant that {side} it at "
            f"{at_neutral} where the same merchant scores {silence} for a user with no "
            f"preference row at all - if this has changed, 0.5 is no longer the ranker's "
            f"no-evidence point and the write plane's default needs re-judging against it")


@pytest.mark.parametrize("kind,key,value,yes,no", PREFERENCES, ids=_IDS)
def test_the_weight_the_api_writes_by_default_changes_the_answer(kind, key, value, yes, no):
    """The delta each side gets from the preference, not the cross-candidate ordering.

    Two candidates that differ on the axis a preference names also differ on the axes the other
    signals read (the cheap merchant in the budget pair scores lower overall), so which one wins
    the page is not this unit's claim. What must hold is the DIRECTION of the preference's own
    contribution: it lifts the merchant that satisfies the user and never lifts the one that does
    not.
    """
    favored = _score(kind, key, value, DECLARED_DEFAULT, **yes)
    favored_silence = _score(kind, key, value, None, **yes)
    unfavored = _score(kind, key, value, DECLARED_DEFAULT, **no)
    unfavored_silence = _score(kind, key, value, None, **no)
    assert favored - favored_silence > 0, (
        f"{kind}/{key}={value!r} at the write plane's own default {DECLARED_DEFAULT} left the "
        f"merchant that satisfies it at {favored}, the score it holds for a user who said "
        f"nothing ({favored_silence}) - the row is stored, listed under §32, and used for nothing")
    assert unfavored - unfavored_silence <= 0, (
        f"{kind}/{key} at {DECLARED_DEFAULT} lifted the merchant that does NOT satisfy it "
        f"({unfavored_silence} -> {unfavored}) - the side of neutral has crossed again (D527)")



def test_a_candidate_with_an_empty_jsonb_is_invisible_to_the_whole_preference_layer():
    """Recorded, not fixed - the shape this gate's fixture deliberately avoids.

    `_enriched_attrs` exists to fold a candidate's OWN columns (`avg_price_hkd`, `district`) into
    the map the budget and location branches read, but the loop that calls it is entered only for
    a merchant that already has a non-empty `attributes` JSONB. A row with none - which no live
    row is today, and which the API's merchant-create path can produce - therefore ignores a
    stated budget or home district entirely, at any weight. This row is the tripwire: fix the
    gate and it goes red, and the fix is to make the fold reachable rather than to widen this
    premise. The dead-point assert below is the control - a preference at 0.5 answers nothing for
    EVERY candidate, so if only that one moves, the fixture broke rather than the product.
    """
    empty = {"attrs": {}, "price": 100, "live_shape": False}
    silence = _score("budget", "per_person_max_hkd", 200, None, **empty)
    at_default = _score("budget", "per_person_max_hkd", 200, DECLARED_DEFAULT, **empty)
    at_neutral = _score("budget", "per_person_max_hkd", 200, NEUTRAL_POINT, **empty)
    assert at_default == pytest.approx(silence), (
        f"a budget preference at the write plane's default now moves a candidate whose JSONB is "
        f"empty ({silence} -> {at_default}) - the gate in `search/service.py` changed, so this "
        f"row has done its job: fold it into the table above instead of restoring the premise")
    assert at_neutral == pytest.approx(silence), (
        f"an empty-JSONB candidate at the dead point moved too ({silence} -> {at_neutral}) - the "
        f"fixture, not the product, is what changed")


