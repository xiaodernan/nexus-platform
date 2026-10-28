"""D581 - a preference that names a merchant weakness demotes the merchant that is weak at it.

The seed writes each merchant's weaknesses as the LIST attribute `weak_aspects` (the ASPECT
names the merchant is weak at - `noise`, `service`, ...), and the ratings lane turns that
list into a demotion of the merchant's own score. The preference lanes read BOOLEAN
attributes only - `attrs.get("x") is True/False` - so a preference that names a weakness had
no branch to act on: a user who refused a weak merchant could not be served away from it
through the preference plane, and the PLAN's open item "the `weak_aspects` attribute is a
LIST, not a boolean" stood.

This gate holds the demotion rule to the fact: a declared refusal of a named weakness
demotes the weak merchant and leaves the strong one alone, and a preference for an aspect
the merchant is not weak at is not answered with a demotion.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import nexus_ai.search.service as S

for _parent in Path(__file__).resolve().parents:
    if (_parent / "data" / "seed" / "generate.py").exists():
        _REPO = _parent
        break
else:
    raise AssertionError("the repository root was not found from this file")

_SERVICE = _REPO / "apps" / "ai" / "nexus_ai" / "search" / "service.py"


def _reader_mentions_weak_aspects() -> bool:
    return "weak_aspects" in _SERVICE.read_text(encoding="utf-8")


def _merchant(sid: str, weak_aspects: list) -> dict:
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "display_name_zh": sid, "category_primary": "cafe",
            "rating_agg": 4.0, "review_count": 10, "avg_price_hkd": 100, "tags": [],
            "attributes": {"data_origin": "demo", "weak_aspects": weak_aspects},
            "kw_score": 0.5, "text_matched": True}


def _run(kind: str, key: str, value: bool, weak_by_sid: dict) -> dict[str, float | None]:
    async def _go() -> dict[str, float | None]:
        class Backend(S.StaticBackend):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                self._prefs: list = []

            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

            async def user_preferences(self, user_id, kinds=None):
                return [dict(p) for p in self._prefs if str(p.get("user_id")) == user_id]

        b = Backend()
        b.merchants = [_merchant(sid, weak_by_sid.get(sid, [])) for sid in ("weak", "strong")]
        b._prefs = [
            {"user_id": "u1", "kind": kind, "key": key,
             "value": json.dumps({"value": value}), "weight": 0.8,
             "source": "declared", "scope": "long_term"},
        ]
        plan = S.SearchPlan(query_text="place", limit=10)
        _cards, _resp, _bundle, scored = await S.search(backend=b, plan=plan, user_id="u1")
        return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}

    return asyncio.run(_go())


def test_the_reader_reads_the_weak_aspects_list() -> None:
    """The source-level half of the D581 gate: the preference reader must name the list."""
    assert _reader_mentions_weak_aspects(), (
        "the search's preference readers never mention `weak_aspects` - a weakness the "
        "seed writes as a list has no reader, and the demotion the PLAN files is missing")


def test_a_declared_refusal_of_a_weakness_demotes_the_weak_merchant() -> None:
    """A user who refuses a weakness is served away from the merchant that is weak at it."""
    got = _run("weakness", "noise", True, {"weak": ["noise"], "strong": []})
    weak_score = got.get("weak")
    strong_score = got.get("strong")
    assert weak_score is not None and strong_score is not None, got
    assert weak_score < strong_score, (
        f"a declared refusal of noise scored the weak merchant {weak_score} and a "
        f"strong one {strong_score} - the weak_aspects list is not read")


def test_a_preference_for_an_aspect_is_not_answered_with_a_demotion_the_merchant_is_strong_at(
        ) -> None:
    """Membership, not substring: a weakness the preference did not name is not its business."""
    got = _run("weakness", "noise", True, {"weak": ["service"], "strong": ["noise"]})
    weak_score = got.get("weak")
    strong_score = got.get("strong")
    assert weak_score is not None and strong_score is not None, got
    assert weak_score > strong_score, (
        f"a preference naming noise scored the merchant weak at service {weak_score} "
        f"above the merchant weak at noise {strong_score} - the list is not read as a set")
