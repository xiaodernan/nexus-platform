"""D531 - a preference the user DECLARES in the NLU's own spelling was unreadable.

The lexicon's `PREFERENCE_RULES` is what the product emits when a user types what they
want, and it carries two spellings of the same fact:

    ("ambience", "quiet",  ["安靜", "静一啲", "quiet", ...], 1)
    ("ambience", "lively", ["熱鬧", "lively", ...], 1)
    ("style",   "ambience", ["有情調", "vibe", ...], 1)

The seed's own comment names the first two - "Ambience preferences (NLU: ambience/quiet,
ambience/lively)" - and the seed declares its demo user's ambience row as
`("style", "ambience", {"value": "quiet"}, 0.6, "inferred")`, a STRING value. So the
stored-preference chain grew a branch for `style/ambience` reading a string, and never
one for `ambience/quiet` or `ambience/lively`, which carry a BOOLEAN.

The two paths then disagreed about which spelling is real. Measured on this corpus, a
preference stored the way the product itself spells it:

    kind=ambience, key=quiet, value={"value": true}  ->  personalization = None
                                                          for all 470 merchants

while the same fact typed into the query box was read correctly - the intent path derives
`quiet_ambience`, which the seed writes. So the TRANSIENT signal worked and the
PERSISTENT one did not: the preference the user saved was the one that did nothing, and
nothing on any surface said so. §33 says the user can inspect and delete their
preferences; a preference whose effect they cannot see is one they cannot inspect.

This is the D518 shape a fourth time (one fact, two readers, the copy serving the live
query was the working one and the stored copy was the broken one) and the mirror image
of D530, where it was the other way round.

It was **proved to fail**: removing the `ambience` branch reddens the checks below (the
probe was put back).

"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.lexicon import PREFERENCE_RULES


class Backend(S.StaticBackend):
    def __init__(self, *a, stored=None, **k):
        super().__init__(*a, **k)
        self._stored = stored or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [dict(p) for p in self._stored]


def _merchant(sid: str, *, quiet, lively) -> dict:
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "display_name_zh": sid,
            "category_primary": "Specialty Coffee", "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": ["specialty-coffee"],
            # the JSONB as the seed writes it
            "attributes": {"data_origin": "demo", "quiet_ambience": quiet,
                           "lively_ambience": lively},
            "kw_score": 0.5, "text_matched": True}


#: the three shapes the corpus can carry: both witnesses, only the wanted one, neither.
QUIET = _merchant("quiet", quiet=True, lively=False)
LOUD = _merchant("loud", quiet=False, lively=True)
UNSTATED = _merchant("unstated", quiet=None, lively=None)

WEIGHT = 0.9


async def _scores(kind: str, key: str, value) -> dict[str, float | None]:
    backend = Backend(merchants=[QUIET, LOUD, UNSTATED], stored=[{
        "user_id": "u1", "kind": kind, "key": key,
        "value": json.dumps({"value": value}), "weight": WEIGHT,
        "source": "declared", "scope": "long_term"}])
    plan = S.SearchPlan(query_text="place", limit=10)
    _cards, _resp, _bundle, scored = await S.search(
        backend=backend, plan=plan, user_id="u1")
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


# ------------------------------------------------- the spelling the NLU emits is readable
async def test_a_declared_quiet_preference_reaches_the_quiet_merchants():
    got = await _scores("ambience", "quiet", True)
    assert got["quiet"] == 0.9, (
        f"a declared `ambience/quiet` scored the quiet merchant at {got['quiet']} - the "
        f"preference is stored in the spelling the product itself emits and the ranker "
        f"has no branch for it")
    assert got["loud"] == pytest.approx(0.1), (
        f"a declared `ambience/quiet` scored the loud merchant at {got['loud']}")


async def test_a_declared_lively_preference_reaches_the_lively_merchants():
    got = await _scores("ambience", "lively", True)
    assert got["loud"] == 0.9, (
        f"a declared `ambience/lively` scored the lively merchant at {got['loud']}")
    assert got["quiet"] == pytest.approx(0.1), (
        f"a declared `ambience/lively` scored the quiet merchant at {got['quiet']}")


async def test_refusing_quiet_serves_the_loud_merchants():
    """A `value: false` row is a refusal, and it must read the other way round."""
    got = await _scores("ambience", "quiet", False)
    assert got["loud"] == pytest.approx(0.9) and got["quiet"] == pytest.approx(0.1), (
        f"a declared refusal of quiet scored {got} - the refusal was read as a request")


# ------------------------------------------------- the two spellings answer the same way
async def test_the_two_spellings_of_one_fact_answer_alike():
    """`style/ambience` (string) and `ambience/quiet` (boolean) are the same fact in the
    product's own vocabulary. They must not disagree about which merchants satisfy it."""
    string_form = await _scores("style", "ambience", "quiet")
    boolean_form = await _scores("ambience", "quiet", True)
    assert string_form == boolean_form, (
        f"the same fact scored {string_form} as `style/ambience` and {boolean_form} as "
        f"`ambience/quiet` - two readers, two answers, and the user cannot tell which "
        f"one their saved preference will get")


async def test_a_merchant_the_corpus_says_nothing_about_stays_unscored():
    """D527's lesson: no evidence, no score - never a guess in either direction."""
    got = await _scores("ambience", "quiet", True)
    assert got["unstated"] is None, (
        f"a merchant the corpus says nothing about scored {got['unstated']}")


# ------------------------------------------------- the cross-plane gate
def test_every_preference_the_nlu_emits_has_a_stored_branch():
    """The (kind, key) pairs the product emits must all be readable from `user_preferences`.

    D527's gate reads the SEED's declared rows against the ranker's branches. This reads
    the LEXICON's rows against the same branches - the seed happens to spell its ambience
    row `style/ambience`, which is why the other gate was green while the spelling the
    NLU itself emits was unreadable.
    """
    import ast

    tree = ast.parse(Path(S.__file__).read_text(encoding="utf-8"))
    branches: set[tuple[str, str]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        kinds, keys = set(), set()
        for sub in ast.walk(node.test):
            if not (isinstance(sub, ast.Compare) and len(sub.ops) == 1):
                continue
            if not isinstance(sub.left, ast.Name):
                continue
            bucket = kinds if sub.left.id == "kind" else (
                keys if sub.left.id == "key" else None)
            if bucket is None:
                continue
            for op in sub.comparators:
                if isinstance(op, ast.Constant) and isinstance(op.value, str):
                    bucket.add(op.value)
                elif isinstance(op, (ast.Tuple, ast.List, ast.Set)):
                    bucket |= {e.value for e in op.elts
                               if isinstance(e, ast.Constant) and isinstance(e.value, str)}
        for kind in kinds:
            for key in keys:
                branches.add((kind, key))

    # rows the stored path answers without an attribute of its own
    not_a_stored_signal = {("style", "ambience")}
    for kind, key, _terms, _pol in PREFERENCE_RULES:
        if (kind, key) in not_a_stored_signal:
            continue
        assert (kind, key) in branches, (
            f"the NLU emits ({kind!r}, {key!r}) and the stored-preference chain has no "
            f"branch for it - a preference saved in the product's own spelling is "
            f"unreadable, and nothing on any surface says so")
