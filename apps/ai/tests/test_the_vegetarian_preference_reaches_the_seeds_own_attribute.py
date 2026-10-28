"""D554 - the search's `cuisine` preference reads the seed's `cuisine_vegetarian` attribute.

The seed writes each merchant's vegetarian fact as the boolean attribute

    "cuisine_vegetarian": m["leaf"] == "vegetarian"

and the NLU emits the `(cuisine, vegetarian)` preference for a query that names one - the
same key spelling the attribute-name gate reads (`<kind>_<key>`). But until now no preference
branch read that boolean: the cuisine reader went through the leaf bridge, which served TYPED
queries but left the stored/declared plane inert - the attribute the seed writes was data no
reader reached, and the full-suite check that holds the two sources apart went red on it
(`the seed writes attributes no matcher reads - dead data that looks load-bearing: ['cuisine_vegetarian']`).

This gate holds the reader to the seed's own boolean:

  * the reader really does read `attrs.get("cuisine_vegetarian") is True/False`;
  * and a DECLARED vegetarian preference now moves a vegetarian merchant UP the ranking and
    a REFUSED one moves it DOWN - the stored plane the attribute path serves.

D532 moved the cuisine tuples into `seed_pools.py`, and D526/D549/D552 taught the bridge and the
gates to read the seed's own derivations; D554 is the last leg of that line: the preference the
seed already writes as a boolean, read as a boolean.

It was **proved to fail**: dropping the `cuisine_vegetarian` boolean read from the search's
stored-preference branch reddens the separation checks below (the probe was put back).
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path


import nexus_ai.search.service as S

for _parent in Path(__file__).resolve().parents:
    if (_parent / "data" / "seed" / "generate.py").exists():
        _REPO = _parent
        break
else:
    raise AssertionError("the repository root was not found from this file")

_SERVICE = _REPO / "apps" / "ai" / "nexus_ai" / "search" / "service.py"
_SEED = _REPO / "data" / "seed" / "generate.py"

#: the preference matchers read a boolean attribute: `attrs.get("x") is True/False`.
_ATTR_RE = re.compile(r'attrs\.get\("([a-z_]+)"\)\s+is\s+(?:True|False)')


def _matcher_keys() -> set[str]:
    text = _SERVICE.read_text(encoding="utf-8")
    return set(_ATTR_RE.findall(text))


def _seed_writes_vegetarian() -> bool:
    text = _SEED.read_text(encoding="utf-8")
    return '"cuisine_vegetarian"' in text


def test_the_seed_writes_the_boolean_attribute_the_gate_is_about():
    """A gate about a row nobody writes would pass forever."""
    assert _seed_writes_vegetarian(), "the seed writes no `cuisine_vegetarian` boolean any more - the gate has gone stale"


def test_the_reader_reads_the_seeds_own_boolean_attribute():
    """The stored-preference branch must read the boolean the seed writes, not re-derive it."""
    assert "cuisine_vegetarian" in _matcher_keys(), (
        f"the search's preference readers never read the `cuisine_vegetarian` attribute - "
        f"the seed writes it and no branch reaches it ({sorted(_matcher_keys())})")


def test_the_seed_writes_no_attribute_nobody_reads_is_green_now():
    """The full-suite gate that went red: the reader this fix adds must register."""
    read = _matcher_keys()
    written = {"cuisine_vegetarian"}
    ignored = {"closed_weekday", "weak_aspects", "demo_login_role", "data_origin",
               "kid_friendly", "has_private_room", "ambience_style", "rainy_day_weather",
               "cheap_price_sense", "premium_price_sense"}
    dead = sorted(written - read - ignored)
    assert not dead, f"the seed writes attributes no matcher reads - dead data that looks load-bearing: {dead}"


def _merchant(sid: str, attrs: dict) -> dict:
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": "Vegetarian Place", "display_name_zh": "素食",
            "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": ["vegetarian"], "attributes": attrs,
            "kw_score": 0.5, "text_matched": True}


def _run(veg_attrs: dict, plain_attrs: dict, value: dict) -> dict[str, float]:
    async def _go():
        class Backend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

            async def user_preferences(self, user_id, kinds=None):
                return [dict(p) for p in self.merchant_prefs if str(p.get("user_id")) == user_id]

        b = Backend()
        b.merchant_prefs = [
            {"user_id": "u1", "kind": "cuisine", "key": "vegetarian",
             "value": value, "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
        b.merchants = [_merchant("m1", veg_attrs), _merchant("m2", plain_attrs)]
        plan = S.SearchPlan(query_text="restaurant", limit=10)
        _cards, _resp, _bundle, scored = await S.search(backend=b, plan=plan, user_id="u1")
        out: dict[str, float] = {}
        for c in scored:
            cid = str(getattr(c.candidate, "merchant_id", None) or getattr(c.candidate, "subject_id", None) or c.candidate.id)
            out[cid] = float(c.candidate.personalization)
        return out

    return asyncio.run(_go())


def test_a_declared_vegetarian_preference_moves_the_ranked_merchant_up():
    """The declared vegetarian preference must separate the two halves of the fact."""
    scores = _run({"cuisine_vegetarian": True}, {"cuisine_vegetarian": False}, {"value": True})
    assert set(scores) >= {"m1", "m2"}, f"the backend scored {sorted(scores)} - a two-merchant probe scored none"
    assert scores["m1"] > scores["m2"], (
        f"a declared vegetarian preference (weight 0.8) scored the vegetarian merchant "
        f"{scores['m1']} and a plain one {scores['m2']} - the stored plane is still inert")


def test_a_refused_vegetarian_preference_moves_the_ranked_merchant_down():
    """The refused vegetarian preference must separate the same two halves, the other way."""
    scores = _run({"cuisine_vegetarian": True}, {"cuisine_vegetarian": False}, {"value": False})
    assert set(scores) >= {"m1", "m2"}, f"the backend scored {sorted(scores)} - a two-merchant probe scored none"
    assert scores["m1"] < scores["m2"], (
        f"a refused vegetarian preference (weight 0.8) scored the vegetarian merchant "
        f"{scores['m1']} and a plain one {scores['m2']} - the stored plane is still inert")
