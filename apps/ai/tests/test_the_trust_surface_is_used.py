"""D503 - the trust layer's public surface is USED by the product, or it is not public.

The trust layer held three functions that no production code called ✓ and each of them
duplicated a rule the product keeps elsewhere ✓:

* `verify_bullets` - a second copy of the §4 renderer rule ✓, and the copy the contract
  FORBIDS ✓: it kept a bullet with no `fact_id` when the bullet's claims happened to
  ground ✓, while the product's guard drops it ✓ (§4: *"If `fact_id` is missing, the UI
  must not render that bullet"*) ✓. The TEST asserted the wrong copy ✓ - so the test was
  green while the product kept a different rule ✓ ✓;
* `pick_authoritative` - a second copy of the §4 source hierarchy ✓ (the product's
  `FactBundle.pick_all` is the picker ✓ - the two agreed on 108 measured cases ✓, so
  nothing was lost ✓, but a second copy is a second thing that can drift ✓);
* `select_display_facts` - a second copy of the display selection ✓ (the card builder picks
  its own facts ✓, computed first ✓).

The D464 census cannot see them ✓ ✓: it counts a read **in the tests** as a read ✓ ✓, so a
function only a test calls survives it ✓ ✓. And the D488 lesson is what they prove ✓ ✓: a
test that asserts a SECOND reader's answer proves nothing about the product's ✓ ✓.

This gate holds the trust layer's public surface to the product ✓ ✓:
  * every name the trust package exports is either CALLED by the product ✓ ✓, or DECLARED
    as a promise the platform lane may ask for ✓ ✓;
  * and the §4 renderer rule has ONE implementation ✓ ✓ - the product's ✓ ✓ - and it is the
    one the contract names ✓ ✓.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from nexus_ai.contract import AiMatch, EntityCard, MatchExplanation
from nexus_ai.search.cards import drop_ungrounded_reasons

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"
TRUST = PACKAGE / "trust"

#: the trust package's exports that the PRODUCT does not call, and why they are a promise
#: rather than a dead name. (D503: the three that used to be here - `verify_bullets`,
#: `pick_authoritative`, `select_display_facts` - were second copies of rules the product
#: keeps elsewhere, and one of them was the copy the contract forbids.)
#: The declared names live in ONE list - the D464 census's - and this gate reads it ✓.
DECLARED: dict[str, str] = {}


def _declared_everywhere() -> dict[str, str]:
    """Every declared export - the D464 census's one list ✓."""
    from test_no_dead_constants import DECLARED_EXPORTS

    return {name: "the D464 census's declared export" for name in DECLARED_EXPORTS}


def _package_reads() -> set[str]:
    """The names the PACKAGE reads - the tests are not the product."""
    out: set[str] = set()
    for path in sorted(PACKAGE.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        except (SyntaxError, OSError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                out.add(node.id)
            elif isinstance(node, ast.Attribute):
                out.add(node.attr)
    return out


def test_the_trust_exports_are_used_or_declared():
    """A public name the product never calls is a promise nobody keeps."""
    import nexus_ai.trust as trust

    reads = _package_reads()
    declared = _declared_everywhere()
    orphans = []
    for name in trust.__all__:
        if name in reads or name in declared:
            continue
        orphans.append(name)
    assert not orphans, (
        f"the trust package exports {orphans} and the PRODUCT never calls them - a public "
        f"name nobody calls is a promise nobody keeps, and the D464 census cannot see it "
        f"(it counts a test's read as a read). Declare it in DECLARED with the reason, or "
        f"delete it.")


def test_the_declared_exports_still_exist():
    """An exception nobody reads is an exception nobody checks."""
    import nexus_ai.trust as trust

    for name in _declared_everywhere():
        if name not in trust.__all__:
            continue  # a declared export of another package
        assert hasattr(trust, name), f"{name} is declared but the package does not have it"


def test_the_renderer_rule_has_one_implementation():
    """§4: a bullet with no `fact_id` must not render - and the trust layer does not keep a
    second copy of that rule."""
    source = (TRUST / "verification.py").read_text(encoding="utf-8")
    assert "def verify_bullets" not in source, (
        "the trust layer keeps a second copy of the §4 renderer rule - and the copy it "
        "kept was the one the contract FORBIDS (a bullet with no fact_id survived when its "
        "claims happened to ground). The product's guard is the rule.")


def test_the_product_drops_a_bullet_without_provenance():
    """The rule the contract names, exercised on the product's own guard."""
    card = EntityCard(
        card_type="merchant", id="11111111-1111-1111-1111-111111111111", slug="x",
        title="x",
        ai_match=AiMatch(score=1.0, reasons=[
            MatchExplanation(label="matches_query", text="HK$320", value="320",
                             fact_id=None)]))
    kept, dropped = drop_ungrounded_reasons(card)
    assert dropped == 1, (
        "a bullet with no fact_id was kept - §4: if `fact_id` is missing, the UI must not "
        "render that bullet")
    assert kept.ai_match.reasons == []


def test_the_sponsored_label_is_the_one_exception():
    """A paid placement is LABELLED as such rather than faked into a trust reason (§1846)."""
    card = EntityCard(
        card_type="merchant", id="11111111-1111-1111-1111-111111111111", slug="x",
        title="x",
        ai_match=AiMatch(score=1.0, reasons=[
            MatchExplanation(label="sponsored", text="Sponsored", value=None, fact_id=None)]))
    kept, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0, "the sponsored label is the one exception"
    assert len(kept.ai_match.reasons) == 1


@pytest.mark.parametrize("name", ["verify_bullets", "pick_authoritative",
                                  "select_display_facts"])
def test_the_second_copies_are_gone(name: str):
    """A second copy of a rule is a second thing that can drift - and the product never
    called these."""
    import nexus_ai.trust as trust

    assert not hasattr(trust, name), (
        f"the trust package has {name} again - it was a second copy of a rule the product "
        f"keeps elsewhere, and the product never called it")
    # the module too - a function that is not exported is still a second copy
    for module in (TRUST / "verification.py", TRUST / "facts.py"):
        source = module.read_text(encoding="utf-8")
        assert f"def {name}(" not in source, (
            f"{module.name} defines {name} again - it was a second copy of a rule the "
            f"product keeps elsewhere, and the product never called it")
