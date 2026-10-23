"""D526 - the word "spicy" speaks the leaves the seed itself derives it from.

The seed writes the demo user's dislike as `food/cuisine_dislike = {"values": ["spicy"]}`,
and it writes each merchant's `spicy_cuisine` attribute as

    m["leaf"] in ("hotpot", "korean", "thai", "indian", "malaysian", "sichuan", "hunan", "mexican")

Those are two statements about ONE fact, and until now nothing held them to each other. The
preference reader resolved "spicy" through the cuisine bridge, found no leaf of that name,
and fell back to the identity - a leaf no merchant carries. Measured on the live corpus
(470 published merchants, read as the demo user), the dislike therefore answered the SAME
number for every merchant, and the merchants the corpus itself calls spicy came out 0.0812
ABOVE the rest: a declared dislike that boosts the very thing it refuses, the D522 shape
seen from the other side.

This gate reads the seed's own derivation and holds the bridge to it:

  * the seed really does declare the dislike this gate is about - a gate written about a
    row nobody writes would pass forever;
  * the bridge's leaves for "spicy" are exactly the seed's derivation, respelled into the
    taxonomy that replaced it (`malaysian` -> `singmal`), with the terms the taxonomy does
    not write dropped (`sichuan`, `hunan`, `mexican`);
  * a merchant carrying one of those leaves matches the cuisine, and a merchant carrying a
    different leaf of the same root does not;
  * and the dislike SEPARATES: a spicy merchant is scored below a merchant that is not,
    which is the entire point of storing a dislike.

It was **proved to fail**: dropping "spicy" from the bridge reddens every check here (the
probe was put back).
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

import pytest

from nexus_ai.nlu.lexicon import CUISINE_LEAVES, cuisine_leaves, cuisine_matches

_SEED_DIR = Path(__file__).resolve().parents[3] / "data" / "seed"
_GENERATOR = _SEED_DIR / "generate.py"

sys.path.insert(0, str(_SEED_DIR))

from seed_pools import CAT_TREE  # noqa: E402  (the writer of the taxonomy the seed derives from)

#: leaf slug -> the root it hangs from - the taxonomy the seed's derivations name.
SEED_LEAVES = {leaf[0]: top[0] for top in CAT_TREE for leaf in top[3]}


def _seed_facts() -> tuple[tuple[str, ...], list[str]]:
    """(the leaves the seed derives `spicy_cuisine` from, the cuisines it declares a dislike of).

    Read out of `data/seed/generate.py` with `ast`, not by importing it: the generator is a
    CLI with a `main()`, and a gate that has to RUN the corpus to read one tuple is a gate
    an unrelated argument can break.
    """
    tree = ast.parse(_GENERATOR.read_text(encoding="utf-8"))
    terms: tuple[str, ...] | None = None
    dislike: list[str] | None = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "spicy_cuisine":
                    assert isinstance(value, ast.Compare) and len(value.comparators) == 1
                    operand = value.comparators[0]
                    assert isinstance(operand, ast.Tuple), (
                        "the seed's spicy_cuisine derivation is no longer a membership test "
                        "against a tuple of leaves - this gate must be re-read against it")
                    terms = tuple(ast.literal_eval(operand))
        if isinstance(node, ast.Tuple) and len(node.elts) >= 3:
            first, second = node.elts[0], node.elts[1]
            if (isinstance(first, ast.Constant) and first.value == "food"
                    and isinstance(second, ast.Constant) and second.value == "cuisine_dislike"):
                payload = node.elts[2]
                assert isinstance(payload, ast.Dict), (
                    "the seed's cuisine_dislike row no longer carries a dict payload")
                fields = {k.value: ast.literal_eval(v)
                          for k, v in zip(payload.keys, payload.values)}
                dislike = list(fields["values"])
    assert terms is not None, "the seed writes no spicy_cuisine derivation at all"
    assert dislike is not None, "the seed declares no food/cuisine_dislike row at all"
    return terms, dislike


SPICY_TERMS, DISLIKED = _seed_facts()

#: the seed's derivation, respelled through the product's own bridge and restricted
#: to the leaves the taxonomy actually writes - the set the bridge is held to below.
SEED_SPICY_LEAVES = tuple(sorted({leaf for term in SPICY_TERMS
                                  for leaf in cuisine_leaves(term)} & set(SEED_LEAVES)))


def test_the_seed_declares_the_dislike_this_gate_is_about():
    """A gate about a row nobody writes would pass forever."""
    assert "spicy" in DISLIKED, (
        f"the seed's food/cuisine_dislike row names {DISLIKED!r}, not the flavour this "
        f"gate reads - the gate has gone stale and must be re-aimed")


def test_the_bridge_carries_the_seeds_own_definition():
    """The bridge's leaves are the seed's derivation, respelled into the taxonomy.

    `malaysian` is the seed's word for the leaf the taxonomy now writes as `singmal`;
    `sichuan`, `hunan` and `mexican` name leaves the taxonomy does not write at all, so
    there is nothing to map them onto and they drop out.
    """
    assert set(CUISINE_LEAVES["spicy"]) == set(SEED_SPICY_LEAVES), (
        f"the bridge says spicy stands for {sorted(CUISINE_LEAVES['spicy'])}, and the "
        f"seed derives spicy_cuisine from {list(SEED_SPICY_LEAVES)} - two readers of one "
        f"fact, and the preference fires on neither")


@pytest.mark.parametrize("leaf", SEED_SPICY_LEAVES, ids=SEED_SPICY_LEAVES)
def test_a_merchant_carrying_a_spicy_leaf_matches_the_word(leaf):
    assert leaf in CUISINE_LEAVES["spicy"], (
        f"the seed derives spicy_cuisine from {leaf!r} and the bridge does not carry it - "
        f"a merchant tagged {leaf!r} cannot match the word spicy")
    assert cuisine_matches("spicy", SEED_LEAVES[leaf].title(), [leaf]) is True, (
        f"the seed derives spicy_cuisine from {leaf!r} and a merchant tagged {leaf!r} "
        f"does not match the word spicy")


def test_a_merchant_carrying_another_leaf_of_the_same_root_does_not():
    """A flavour is not a root: a Cantonese diner is not a spicy restaurant."""
    root = SEED_LEAVES[CUISINE_LEAVES["spicy"][0]]
    sibling = next(leaf for leaf in sorted(SEED_LEAVES)
                   if SEED_LEAVES[leaf] == root and leaf not in CUISINE_LEAVES["spicy"])
    assert cuisine_matches("spicy", sibling.title(), [sibling]) is False, (
        f"a merchant tagged {sibling!r} now matches the word spicy - the bridge has "
        f"widened the flavour into its whole root")


def test_the_declared_dislike_separates_the_merchants():
    """The behavioural half: the stored dislike must move a spicy merchant DOWN.

    Measured on the live corpus before the fix: the dislike answered 0.8 for every one of
    the 470 published merchants, so the merchants the corpus calls spicy finished 0.0812
    ABOVE the rest. A dislike that cannot separate is a dislike that is not stored.
    """
    import asyncio

    import nexus_ai.search.service as S

    class Backend(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id, kinds=None):
            return [dict(p) for p in self.merchant_prefs
                    if str(p.get("user_id")) == user_id]

    spicy_leaf = SEED_SPICY_LEAVES[0]
    plain_leaf = next(leaf for leaf in sorted(SEED_LEAVES)
                      if SEED_LEAVES[leaf] == SEED_LEAVES[spicy_leaf]
                      and leaf not in CUISINE_LEAVES["spicy"])

    def row(sid, leaf):
        return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
                "display_name": leaf.title(), "display_name_zh": leaf,
                "category_primary": SEED_LEAVES[leaf].title(), "rating_agg": 4.0,
                "review_count": 10, "avg_price_hkd": 100, "tags": [leaf],
                "attributes": {"data_origin": "demo"}, "kw_score": 0.5,
                "text_matched": True}

    async def score(leaf):
        backend = Backend(merchants=[row("m1", leaf)])
        backend.merchant_prefs = [
            {"user_id": "u1", "kind": "food", "key": "cuisine_dislike",
             "value": json.dumps({"values": ["spicy"]}),
             "weight": 0.8, "source": "declared", "scope": "long_term"}]
        plan = S.SearchPlan(query_text="place", limit=10)
        _cards, _resp, _bundle, scored = await S.search(backend=backend, plan=plan, user_id="u1")
        return scored[0].candidate.personalization

    spicy_score = asyncio.run(score(spicy_leaf))
    plain_score = asyncio.run(score(plain_leaf))
    assert spicy_score < plain_score, (
        f"the declared dislike of the word spicy scores a merchant the seed calls spicy "
        f"({spicy_leaf!r}) at {spicy_score} and a merchant it does not ({plain_leaf!r}) at "
        f"{plain_score} - the dislike is not stored anywhere a reader can reach")
