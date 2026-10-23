"""D525 - the cuisine bridge speaks the leaves the seed actually writes.

The lexicon's cuisine bridge says of itself:

    The leaves are the ones `data/seed/seed_pools.py`'s `CAT_TREE` writes; a leaf not
    listed here is matched by its own name.

That is a claim about a file in another plane, and nothing read the file. A leaf the bridge
names that the taxonomy does not write is a leaf no merchant can ever carry: the preference
fires on nothing, and a satisfied preference becomes the same as an unsatisfied one (D394).

This gate reads the seed and holds the bridge to it:

  * every leaf the bridge names is a leaf `CAT_TREE` writes - spelled the seed's way;
  * every cuisine the vocabulary names has a bridge entry that resolves to a real leaf;
  * and the bridge is not vacuously true: the taxonomy's own food leaves are reachable
    through it, so the mapping has not quietly emptied itself.

It was **proved to fail**: renaming one bridged leaf to a slug the seed does not write
reddens the first check, and emptying one cuisine's leaf tuple reddens the second (the
probe was put back).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from nexus_ai.nlu.lexicon import CUISINE_LEAVES, CUISINE_TERMS, cuisine_leaves, cuisine_matches

_SEED = Path(__file__).resolve().parents[3] / "data" / "seed"
sys.path.insert(0, str(_SEED))

from seed_pools import CAT_TREE  # noqa: E402  (the writer of the taxonomy the bridge names)

#: (top slug, leaf slug) - every leaf the seed writes, and the root it hangs from
SEED_LEAVES = {leaf[0]: top[0] for top in CAT_TREE for leaf in top[3]}
SEED_ROOTS = {top[0] for top in CAT_TREE}


def test_the_seed_is_the_one_this_gate_reads():
    """A gate that reads an empty tree would pass everything."""
    assert len(SEED_ROOTS) == 10 and len(SEED_LEAVES) == 67, (
        f"the seed holds {len(SEED_ROOTS)} roots and {len(SEED_LEAVES)} leaves - this gate "
        f"was written against 10 and 67, so it is no longer reading the taxonomy it claims")


@pytest.mark.parametrize("cuisine", sorted(CUISINE_LEAVES), ids=sorted(CUISINE_LEAVES))
def test_every_leaf_the_bridge_names_is_a_leaf_the_seed_writes(cuisine):
    for leaf in CUISINE_LEAVES[cuisine]:
        assert leaf in SEED_LEAVES, (
            f"the bridge says {cuisine!r} stands for {leaf!r}, and the seed's CAT_TREE does "
            f"not write that leaf - no merchant can carry it, so the preference can never "
            f"fire")


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_every_cuisine_the_vocabulary_names_resolves_to_a_real_leaf(cuisine):
    leaves = cuisine_leaves(cuisine)
    assert leaves, f"the cuisine {cuisine!r} resolves to no leaf at all"
    for leaf in leaves:
        assert leaf in SEED_LEAVES, (
            f"the cuisine {cuisine!r} resolves to {leaf!r}, which the seed does not write")


def test_the_bridge_is_not_vacuous():
    """The mapping must still carry the taxonomy's food leaves, not just itself."""
    covered = {leaf for leaves in CUISINE_LEAVES.values() for leaf in leaves}
    for leaf in ("sushi", "ramen", "izakaya", "cantonese", "dimsum", "seafood-grill",
                 "western-grill", "singmal", "vegetarian", "specialty-coffee"):
        assert leaf in covered, (
            f"the taxonomy leaf {leaf!r} is no longer reachable through the bridge - the "
            f"mapping has emptied itself and every cuisine now matches only itself")


def test_an_unknown_cuisine_is_matched_by_its_own_name():
    """The documented fallback: a cuisine the taxonomy does not know is still a word a
    merchant may carry in its tags."""
    assert cuisine_leaves("not_a_cuisine") == ("not_a_cuisine",)


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_a_merchant_carrying_the_leaf_matches_the_cuisine(cuisine):
    """The behavioural half: the leaf the seed writes is the leaf that fires."""
    leaf = CUISINE_LEAVES[cuisine][0]
    root = SEED_LEAVES[leaf]
    assert cuisine_matches(cuisine, SEED_LEAVES[leaf].title(), [leaf]) is True, (
        f"a merchant tagged {leaf!r} does not match the cuisine {cuisine!r}")
    # The root alone must NOT satisfy the cuisine: a merchant that merely sits in the
    # restaurant root, with none of the cuisine's leaves, is a merchant that does not serve
    # it. D394 - a satisfied preference has to differ from an unsatisfied one, and this is
    # the half of that distinction that lives in the bridge rather than in the reader.
    assert cuisine_matches(cuisine, root, []) is False, (
        f"a merchant in the {root!r} root with no tags now matches the cuisine "
        f"{cuisine!r} - every merchant in the root satisfies the preference, so the "
        f"preference no longer separates anything")
    # ...and a leaf from a different cuisine in the same root must not satisfy it either.
    other = next((leaf for leaf in sorted(SEED_LEAVES)
                  if leaf not in CUISINE_LEAVES[cuisine] and SEED_LEAVES[leaf] == root), None)
    if other is not None:
        assert cuisine_matches(cuisine, other, [other]) is False, (
            f"a merchant tagged {other!r} now matches the cuisine {cuisine!r} - the "
            f"bridge has widened past the leaves the seed writes for it")
