"""D530 - the preference the user TYPES reaches the attribute the corpus writes.

`time_pref/open_late` is the one row in the lexicon's `PREFERENCE_RULES` whose attribute
is not spelled `{value}_{kind}` or `{kind}_{value}`. The intent path derived
`open_late_time_pref` and `time_pref_open_late`; the seed, the stored branch and the
corpus all spell it `opens_late`. So the same fact had two readers and the one serving
the live query could not see it: measured on the live plane a user typing a late-night
request changed 0 of 470 merchants, while the corpus splits 266 / 204 on `opens_late` and
the stored path scores those halves 0.9 / 0.1.

This is the behavioural half of the unit - the cross-plane spelling is held by
`test_the_typed_preference_speaks_the_corpus_spelling.py`. It was **proved to fail**:
dropping `opens_late` out of `_INTENT_ATTR_ALIASES` reddens the checks below (the probe
was put back).

"""

from __future__ import annotations

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.understand import extract_intent


class Backend(S.StaticBackend):
    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]


def _merchant(sid: str, *, opens_late: bool) -> dict:
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "display_name_zh": sid,
            "category_primary": "Cha Chaan Teng", "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": ["cha-chaan-teng"],
            # the JSONB as the seed writes it - `opens_late`, never `open_late_time_pref`
            "attributes": {"data_origin": "demo", "opens_late": opens_late},
            "kw_score": 0.5, "text_matched": True}


LATE = _merchant("late", opens_late=True)
EARLY = _merchant("early", opens_late=False)

#: the query, taken from the lexicon's own row for `time_pref/open_late`
QUERY = "想搵夜宵"


@pytest.fixture(scope="module")
def typed() -> list[dict]:
    ex = extract_intent(QUERY, {"locale": "zh-HK"})
    prefs = [p if isinstance(p, dict) else p.model_dump() for p in ex.preferences]
    assert prefs, f"{QUERY!r} resolved no preference - the fixture is not what it claims"
    assert prefs[0]["key"] == "time_pref" and prefs[0]["value"] == "open_late", prefs
    return prefs


async def _scores(intent_prefs) -> dict[str, float | None]:
    backend = Backend(merchants=[LATE, EARLY])
    plan = S.SearchPlan(query_text="place", limit=10)
    _cards, _resp, _bundle, scored = await S.search(
        backend=backend, plan=plan, intent_preferences=intent_prefs)
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


async def test_a_typed_late_night_preference_reaches_the_merchant_that_stays_open(typed):
    got = await _scores(typed)
    assert got["late"] == 1.0, (
        f"a user who typed {QUERY!r} left the merchant that stays open at "
        f"{got['late']} - the preference named an attribute the corpus does not write")


async def test_a_typed_late_night_preference_demotes_the_one_that_closes(typed):
    got = await _scores(typed)
    assert got["early"] == 0.0, (
        f"a user who typed {QUERY!r} left the merchant that closes at {got['early']} - "
        f"the preference named an attribute the corpus does not write")


async def test_the_two_halves_are_separated(typed):
    """The lane has to be able to order the two halves, or it contributes nothing."""
    got = await _scores(typed)
    assert got["late"] > got["early"], (
        f"the late merchant scored {got['late']} and the early one {got['early']}")


async def test_the_same_preference_declared_and_typed_read_the_same_attribute():
    """One fact, one reader, one spelling (D527). The stored branch names `opens_late`;
    the intent path must not name something else for the same (kind, key)."""
    import json

    class WithStored(Backend):
        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": "time_pref", "key": "open_late",
                     "value": json.dumps({"value": True}), "weight": 1.0,
                     "source": "declared", "scope": "long_term"}]

    plan = S.SearchPlan(query_text="place", limit=10)
    _cards, _resp, _bundle, scored = await S.search(
        backend=WithStored(merchants=[LATE, EARLY]), plan=plan, user_id="u1")
    stored = {str(s.candidate.subject_id): s.candidate.personalization for s in scored}
    assert stored["late"] == 1.0 and stored["early"] == 0.0, (
        f"the declared preference scored {stored} - if the two readers disagree about "
        f"which attribute answers this preference, this gate has lost its subject")
