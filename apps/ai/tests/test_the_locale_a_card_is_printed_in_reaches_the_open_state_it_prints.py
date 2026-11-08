"""D730 - the locale a card is printed in reaches the function that computes the open state it prints.

Measured under the working number D727, which the concurrent lane took for its own in-flight
party-size grid unit (`sql.py`'s `entities_for` docstring and `cards.py`'s new cell copy both say
D727). This ships as D730 (§730); the records keep the names they were written under where a
committed section already cites them, and the d730_* records are the renamed ones.

`5d9c8c1` ("D725: localize compute_open open_state text for card and compare grid") taught
`cards.compute_open` a `locale` parameter and pointed three callers at it. Two of them have a locale
in scope. The third does not: `search/service.py`'s `candidates_from_rows` was given `locale=locale`
in its `compute_open` call and was given no `locale` parameter, and its one caller - `search()`, which
DOES have one - does not pass it. So the name is looked up in the module globals, is not there, and
every MERCHANT row raises `NameError`. Measured at `88cae10` (`tmp/d727_measure.txt`):

  * the pure function, called the way `test_candidates_from_rows.py` calls it with a merchant row and
    hours: `NameError: name 'locale' is not defined` at `service.py:1281`. Asking it for a locale
    instead answers `TypeError: unexpected keyword argument 'locale'`. An OFFERING row maps fine -
    it never reaches `compute_open` - so the breakage is exactly the merchant half of the plane.
  * `POST /ai/v1/search` answers **503** `ai_unavailable` "search backend unavailable: name 'locale'
    is not defined" for all three bodies tried (intent carried, query only, locale en). The stream
    route answers 200 and then emits `{"code": "internal", "message": "name 'locale' is not defined"}`
    instead of rows. The deterministic search plane is down.
  * the compare grid - the other caller D725 pointed at `compute_open` - is NOT down: it answers 200
    and its `open_state` cells really are localized (`營業至 01:30` / `Open until 01:30`). So the unit
    that broke the card path measured the grid path and `test_cards.py`, which calls `compute_open`
    directly, and ran no gate that maps a merchant row.
  * blast radius: of 317 shipped test files, 4 call `candidates_from_rows` by name and 68 post the
    route or call the pipeline; 2 do both.

What ships is the missing thread, and nothing else: `candidates_from_rows` declares
`locale: str = "zh-HK"` - the same default `compute_open` and `search()` already use - and `search()`
passes its own locale at the call site. One locale for the whole card: the open state's text and the
card's other localized text are computed from the same argument, which is what D725 promised and
what the NameError prevented anyone from ever seeing.

Pinned as NOT this unit's claim: `compute_open`'s own signature and default, the grid's localization
(which already worked), the offering row's silence about opening hours, and the row mapper's other
twelve parameters - the fix adds one keyword and removes none.
"""

from __future__ import annotations

import asyncio
import inspect
import os
from datetime import datetime, timezone

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.cards import compute_open
from nexus_ai.search.ranking import RankingWeights

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

#: a fixed clock: 12:00 UTC is 20:00 HKT on a Sunday, inside the hours below, so the state is OPEN
#: and the text is the `open_until` template in whichever locale was asked for.
NOW = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)
KEY = "m1"
HOURS = [{"merchant_id": KEY, "weekday": d, "opens_at": "07:00", "closes_at": "23:00",
          "crosses_midnight": False} for d in range(7)]
ROW = {"subject_type": "merchant", "subject_id": KEY, "merchant_id": KEY,
       "display_name": "咖啡店", "display_name_zh": "咖啡店", "category_primary": "cafe",
       "kw_score": 0.8, "rating_agg": 4.5, "review_count": 10, "tenant_mean_rating": 4.0,
       "avg_price_hkd": 50.0, "price_amount": 100, "tags": [], "attributes": {},
       "district": "Sha Tin", "data_origin": "demo"}
#: what each locale's `open_until` template says, read off `cards.OPEN_STATE_COPY` and not invented
COPY = {"zh-HK": "營業至 23:00", "zh-CN": "营业至 23:00", "en": "Open until 23:00"}


def _plan(**over):
    base = dict(query_text="", filters={}, limit=10, subject_types=("merchant",), now=NOW)
    base.update(over)
    return S.SearchPlan(**base)


def _map(rows, *, hours=None, locale=None, plan=None):
    kw = {} if locale is None else {"locale": locale}
    return S.candidates_from_rows(rows, plan or _plan(), bundle=None, facts_by_subject={},
                                  hours_by_merchant={KEY: HOURS if hours is None else hours},
                                  slots_by_merchant={}, personalization={},
                                  weights=RankingWeights(), vector_lane=False, **kw)


def _cards(locale):
    backend = S.StaticBackend(merchants=[dict(ROW)], hours=[dict(h) for h in HOURS])
    cards, _resp, _bundle, _scored = asyncio.run(
        S.search(backend=backend, plan=_plan(), locale=locale))
    return cards


# ------------------------------------------------------------------ the thread itself
def test_the_row_mapper_declares_the_locale_it_uses():
    params = inspect.signature(S.candidates_from_rows).parameters
    assert "locale" in params, sorted(params)
    assert params["locale"].default == "zh-HK", params["locale"].default
    assert params["locale"].kind is inspect.Parameter.KEYWORD_ONLY, params["locale"].kind


def test_a_merchant_row_with_hours_maps_at_all():
    out = _map([dict(ROW)])
    assert len(out) == 1
    assert out[0].raw["open_state"]["is_open"] is True, out[0].raw["open_state"]


@pytest.mark.parametrize("locale", sorted(COPY))
def test_the_open_state_text_is_the_locale_the_caller_asked_for(locale):
    state = _map([dict(ROW)], locale=locale)[0].raw["open_state"]
    assert state["text"] == COPY[locale], (locale, state)
    assert state == compute_open(HOURS, now=NOW, locale=locale), locale


def test_the_default_is_the_locale_the_rest_of_the_plane_defaults_to():
    state = _map([dict(ROW)])[0].raw["open_state"]
    assert state["text"] == COPY["zh-HK"], state
    assert state == compute_open(HOURS, now=NOW), state


def test_the_search_lane_threads_its_own_locale_into_the_row_map():
    for locale, text in COPY.items():
        cards = _cards(locale)
        assert cards, locale
        assert cards[0].open.text == text, (locale, cards[0].open)


def test_the_card_and_the_open_state_it_prints_agree_about_one_locale():
    cards = _cards("en")
    state = cards[0].open
    assert state.text == compute_open(HOURS, now=NOW, locale="en")["text"]
    assert state.is_open is True
    #: the fact the card cites carries the same text, so the citation and the print agree
    assert cards[0].open.source_fact_id is not None, cards[0].open


# ------------------------------------------------------------------ not this unit's claim
def test_not_this_units_claim_an_offering_row_still_says_nothing_about_opening():
    row = {**ROW, "subject_type": "product", "subject_id": "o1"}
    out = _map([row], hours=[])
    assert len(out) == 1
    assert out[0].raw.get("open_state") is None, out[0].raw.get("open_state")


def test_not_this_units_claim_compute_open_keeps_its_own_signature_and_default():
    params = inspect.signature(compute_open).parameters
    assert list(params) == ["hours", "now", "at", "locale"], sorted(params)
    assert params["locale"].default == "zh-HK"
    assert compute_open(HOURS, now=NOW)["text"] == COPY["zh-HK"]


def test_not_this_units_claim_the_row_mappers_other_parameters_are_unchanged():
    params = list(inspect.signature(S.candidates_from_rows).parameters)
    assert params == ["rows", "plan", "bundle", "facts_by_subject", "hours_by_merchant",
                      "slots_by_merchant", "personalization", "weights", "vector_lane",
                      "vector_semantic", "typed_cuisine", "preference_labels", "locale"], params


def test_not_this_units_claim_a_merchant_with_no_hours_is_still_unknown():
    state = _map([dict(ROW)], hours=[], locale="en")[0].raw["open_state"]
    assert state["is_open"] is None and state["text"] is None, state


# ------------------------------------------------------------------ served, live plane
def _live_client():
    from contextlib import contextmanager

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")

    @contextmanager
    def open_client():
        with TestClient(create_app(settings)) as c:
            health = c.get("/ai/v1/health").json()
            assert health["database"]["available"], (
                f"the live plane is not answering: {health['database']['error']}")
            yield c

    return open_client()


@live_only
def test_the_served_search_route_answers_instead_of_503():
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": "咖啡店", "limit": 3, "locale": "zh-HK"})
    assert r.status_code == 200, r.text
    assert r.json().get("items"), r.json()


@live_only
def test_the_served_card_prints_the_locale_the_request_asked_for():
    seen = {}
    with _live_client() as client:
        for locale in ("en", "zh-HK"):
            r = client.post("/ai/v1/search", json={"query": "咖啡店", "limit": 8, "locale": locale})
            assert r.status_code == 200, r.text
            texts = [(c.get("open") or {}).get("text") for c in r.json()["items"]]
            seen[locale] = [t for t in texts if t]
    assert seen["en"] and seen["zh-HK"], seen
    assert all(any(w in t for w in ("Open until", "Opens", "Closed")) for t in seen["en"]), seen
    assert all(any(w in t for w in ("營業至", "開門", "已休息")) for t in seen["zh-HK"]), seen


@live_only
def test_the_stream_route_serves_rows_instead_of_an_internal_error_frame():
    import json

    with _live_client() as client:
        with client.stream("POST", "/ai/v1/search/stream",
                           json={"query": "咖啡店", "limit": 3}) as resp:
            assert resp.status_code == 200
            frames = [json.loads(ln[5:].strip()) for ln in resp.iter_lines()
                      if ln.startswith("data:")]
    errors = [f for f in frames if f.get("code")]
    assert not errors, errors
    assert any("items" in f for f in frames), [sorted(f) for f in frames]


@live_only
def test_not_this_units_claim_the_compare_grid_was_never_broken():
    """The other caller D725 pointed at `compute_open` had a locale in scope and still does."""
    import asyncpg

    async def two_ids():
        conn = await asyncpg.connect(DB_URL)
        try:
            rows = await conn.fetch(
                "SELECT id FROM merchants WHERE tenant_id = $1::uuid AND status = 'published' "
                "ORDER BY id LIMIT 2", "00000000-0000-0000-0000-000000000001")
            return [str(r["id"]) for r in rows]
        finally:
            await conn.close()

    ids = asyncio.run(two_ids())
    assert len(ids) == 2, ids
    texts = {}
    with _live_client() as client:
        for locale in ("zh-HK", "en"):
            r = client.post("/ai/v1/compare", json={"subject_ids": ids, "locale": locale})
            assert r.status_code == 200, r.text
            row = next((x for x in r.json()["rows"] if x["attribute"] == "open_state"), None)
            texts[locale] = [c.get("value") for c in (row or {}).get("cards", [])]
    assert any(texts["zh-HK"]) and any(texts["en"]), texts
    assert texts["zh-HK"] != texts["en"], texts