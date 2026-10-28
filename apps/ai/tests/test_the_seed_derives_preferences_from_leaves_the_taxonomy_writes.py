"""D532 - the seed derived two of the preference attributes from names the taxonomy does not carry.

The seed writes the merchant `attributes` the ranker reads, and it derives the preference
ones from the merchant's category:

    "solo_occasion":  m["leaf"] in ("cafe", "bakery", "restaurant", "fast_food")
    "scenic_view":    m["leaf"] in ("attraction", "hotel", "rooftop", "seafood") and rng < 0.3
    "date_occasion":  m["leaf"] in ("restaurant", "cafe", "bar", ... )

Every name in those tuples has to be a leaf the taxonomy writes, or the comparison is
against a string no merchant can ever carry. They were not. `restaurant`, `cafe`, `bar`
and `hotel` are TOPS, not leaves - a merchant's leaf is `sushi` or `ramen`, never
`restaurant`. `western`, `seafood`, `dim_sum`, `malaysian`, `bakery`, `bbq`,
`cooking_class`, `japanese` and `escape_room` are respellings of leaves. And `attraction`,
`park`, `rooftop`, `fast_food`, `sichuan`, `hunan` and `mexican` name no leaf at all.

Measured on the seed's own output (60 merchants):

    before:  solo_occasion True for 0 of 60      scenic_view True for 0 of 60
             date_occasion 4   group 1   family 1   business 1   spicy 3
    after:   solo_occasion True for 27 of 60     scenic_view True for 2 of 60
             date_occasion 34  group 25  family 28  business 30  spicy 3

So two attributes were dead on every row and four more were nearly so, while the NLU
emits a rule for each of them - and D528 had just wired the occasion matcher to its
weight, which weighted a flag that was always False. The user is told they have a
preference for somewhere to eat alone; the corpus says nothing; the ranking lane answers
from a constant.

The fix moves the sets into `seed_pools.py` beside the tree they name, reads the tops off
the tree instead of retyping them, and drops the names that resolve to nothing. This gate
holds the two planes to each other, so a dead term reddens instead of landing silently.
It was **proved to fail**: putting a name that is not a leaf back into any set reddens the
check below (the probe was put back).

"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

_SEED = Path(__file__).resolve().parents[3] / "data" / "seed"
sys.path.insert(0, str(_SEED))

import seed_pools as P  # noqa: E402  (the writer of the taxonomy the seed names)

_GENERATOR = _SEED / "generate.py"

#: the attributes the seed derives from a category, and the set each now reads
DERIVATIONS = {
    "date_occasion": "DATE_LEAVES",
    "group_occasion": "GROUP_LEAVES",
    "family_occasion": "FAMILY_LEAVES",
    "business_occasion": "BUSINESS_LEAVES",
    "solo_occasion": "SOLO_LEAVES",
    "scenic_view": "SCENIC_LEAVES",
    "spicy_cuisine": "SPICY_LEAVES",
    "outdoor_style": "OUTDOOR_LEAVES",
}

SEED_LEAVES = {leaf[0] for top in P.CAT_TREE for leaf in top[3]}
SEED_ROOTS = {top[0] for top in P.CAT_TREE}


def _attrs_dict() -> ast.Dict:
    """The seed's merchant `attrs` literal, read out of the generator's source."""
    tree = ast.parse(_GENERATOR.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {k.value for k in node.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)}
            if "data_origin" in keys and "quiet_ambience" in keys:
                return node
    raise AssertionError("the seed's merchant `attrs` dict was not found")


def _derivation_source(attr: str) -> str:
    for key, value in zip(_attrs_dict().keys, _attrs_dict().values):
        if isinstance(key, ast.Constant) and key.value == attr:
            return ast.unparse(value)
    raise AssertionError(f"the seed no longer writes a {attr!r} attribute")


# ------------------------------------------------------------------ the taxonomy is the one
def test_the_taxonomy_is_the_one_this_gate_reads():
    """A gate that reads an empty tree would pass everything."""
    assert len(SEED_ROOTS) == 10 and len(SEED_LEAVES) == 67, (
        f"the seed holds {len(SEED_ROOTS)} roots and {len(SEED_LEAVES)} leaves - this gate "
        f"was written against 10 and 67, so it is no longer reading the taxonomy it claims")


# ------------------------------------------------------------------ every name is a leaf
@pytest.mark.parametrize("name", sorted(P.PREFERENCE_LEAF_SETS), ids=sorted(P.PREFERENCE_LEAF_SETS))
def test_every_name_in_a_preference_set_is_a_leaf_the_taxonomy_writes(name):
    """The heart of it. A name that is not a leaf is a comparison no merchant can satisfy,
    so the attribute is False on every row and the preference is inert."""
    dead = sorted({t for t in P.PREFERENCE_LEAF_SETS[name] if t not in SEED_LEAVES})
    assert not dead, (
        f"{name} names {dead}, and the taxonomy writes no such leaf - every merchant "
        f"answers False to it and the preference the NLU emits can never fire")


@pytest.mark.parametrize("attr,set_name", sorted(DERIVATIONS.items()),
                         ids=sorted(DERIVATIONS))
def test_the_derivation_reads_the_set_it_is_meant_to(attr, set_name):
    """The derivation must go through the named set, so the gate above covers it. An inline
    tuple is a spelling nobody checks."""
    source = _derivation_source(attr)
    assert f"in {set_name}" in source, (
        f"the seed derives {attr!r} from {source!r}, not from {set_name} - an inline tuple "
        f"is a spelling this gate cannot see")


def test_no_derivation_names_a_top_where_a_leaf_is_meant():
    """`restaurant`, `cafe`, `bar` and `hotel` are roots, not leaves. A merchant's leaf is
    `sushi`, never `restaurant`."""
    for attr, set_name in sorted(DERIVATIONS.items()):
        roots = sorted(SEED_ROOTS & set(P.PREFERENCE_LEAF_SETS[set_name]))
        assert not roots, (
            f"{set_name} (read by {attr!r}) carries the root name(s) {roots} - a root is "
            f"not a leaf, so no merchant's leaf can equal it")


def test_the_sets_are_not_vacuously_small():
    """A set that resolved to nothing would pass every check above and still leave the
    attribute dead. `OUTDOOR_LEAVES` is empty on purpose and is named here so it is the
    only one allowed to be."""
    allowed_empty = {"OUTDOOR_LEAVES"}
    for name, leaves in sorted(P.PREFERENCE_LEAF_SETS.items()):
        if name in allowed_empty:
            continue
        assert len(leaves) >= 3, (
            f"{name} holds {len(leaves)} leaf/leaves - the preference it answers is inert "
            f"on almost every merchant")


def test_outdoor_is_empty_because_the_taxonomy_has_no_outdoor_leaf():
    """Recorded, not assumed: the taxonomy has no leaf for an outdoor venue, so the flag is
    the generator's own random fallback and nothing else."""
    assert P.OUTDOOR_LEAVES == ()
    outdoorish = {leaf for leaf in SEED_LEAVES
                  if any(w in leaf for w in ("outdoor", "park", "rooftop", "attraction"))}
    assert not outdoorish, (
        f"the taxonomy now carries {sorted(outdoorish)} - OUTDOOR_LEAVES can stop being "
        f"empty and the fallback can stop carrying the flag alone")


# ------------------------------------------------------------------ the generated output
def test_the_generated_corpus_carries_each_preference_on_both_sides():
    """A set that is right on paper and dead in the output proves nothing. This runs the
    generator and reads the attributes it actually wrote.

    D586: it ran at `--merchants 60` until that census started failing on `scenic_view`, and
    the failure was the GATE's, not the corpus's. Measured at the fixed default seed
    (20260921), the attribute is written True for 0 of 60, 2 of 120, 6 of 240 and 11 of 520
    merchants - about a 2% rate - so at 60 the check was a coin toss on a draw it could not
    see, and a rare-but-live fact was being reported as dead. A census asserts something only
    if the sample can carry it, so this now runs at the generator's own shipped scale, which
    is the corpus the product is served (`--merchants` default 520, measured 20s).
    """
    import csv
    import io
    import json
    import tempfile

    out = tempfile.mkdtemp(prefix="nexus_seed_gate_")
    import generate as G  # noqa: E402  (the generator this gate is holding to the tree)

    rc = G.main(["--reviews", "200", "--days", "2", "--out", out, "--skip-selfcheck"])
    assert rc == 0, "the generator refused to run"
    raw = (Path(out) / "06_merchants.sql").read_text(encoding="utf-8").split("\n")
    header = next(line for line in raw if line.startswith("COPY "))
    cols = header[header.index("(") + 1:header.index(")")].split(", ")
    at = cols.index("attributes")
    rows = [p for p in (next(csv.reader(io.StringIO(line)), []) for line in raw
                        if line and not line.startswith(("COPY", "--", "\\")))
            if len(p) == len(cols)]
    assert rows, "the generator wrote no merchant rows"
    # D586: the census means nothing below the scale that can carry it. If someone puts a
    # small `--merchants` back, this fails as "the sample is too small to census" instead of
    # reporting the rarest attribute as dead.
    assert len(rows) >= 500, (
        f"the census ran on {len(rows)} merchants - at that scale a 2%-rate attribute like "
        f"scenic_view is absent about half the time, so a zero here would say more about the "
        f"sample than about the corpus")
    counts = {attr: 0 for attr in DERIVATIONS}
    for parts in rows:
        attrs = json.loads(parts[at])
        for attr in DERIVATIONS:
            if attrs.get(attr) is True:
                counts[attr] += 1
    for attr, set_name in sorted(DERIVATIONS.items()):
        if set_name == "OUTDOOR_LEAVES":
            continue
        assert counts[attr] > 0, (
            f"the generator wrote {attr!r} as True for 0 of {len(rows)} merchants (the other "
            f"census counts are {counts}) - the attribute is dead in the corpus the product "
            f"is served, so the preference the NLU emits is inert")
