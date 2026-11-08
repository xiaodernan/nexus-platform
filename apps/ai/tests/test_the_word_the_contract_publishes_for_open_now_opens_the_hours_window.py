"""D725 - the one published spelling of 「開唔開」 opens the hours window its own description promises.

The number: this unit was measured under the working number D711, and the concurrent lane landed
D711 (§690) on the visual plane while the measurement was in flight, so it ships as D725 (§725).
The records keep the filenames they were written under - `tmp/d711_published_domain.txt` is also the
file §689 already cites, and renaming it would strand a committed citation.

`packages/types/src/schemas/intent.json` closes `time.type` to `TimeRefType` =
`["explicit","relative","range","open_now","unspecified"]` and its description says what the fifth
member is for: "`open_now` triggers the live-hours computation (AGENT_CONTRACT §5, TTL 24h for hours
but 0 for availability)". `packages/types/fixtures/intent.json` ships a frame that uses it. The
served model is the closed other half of the same field, `IntentTime.type`, and it declared four
members. Measured over both planes (`tmp/d711_published_domain.txt`, `tmp/d711_opennow_plan.txt`):

  * INBOUND, strict route - `Intent.model_validate` of the published frame raises `literal_error` at
    `('time','type')` ("Input should be 'explicit', 'relative', 'range' or 'unspecified'"), so
    `POST /ai/v1/search` answers 422 for a body the contract permits. This is D710's direction again:
    the caller that reads the published shape is the one the service refuses.
  * INBOUND, lenient route - `pipeline.validate_intent` of the same frame returns None, and
    `pipeline.py:105` does `validate_intent(...) or Intent(raw_query=query)`, so the route that is
    forgiving does not answer 422, it throws the carried state away.
  * AND READ - with validation bypassed, the ref reaches the planner and changes nothing:
    `plan.open_now=False`, `plan.filters["open_now"]=False`, `_slot_window=None`. The spelling that
    does open it, `urgency="now"`, gives `open_now=True` and the `(now, now+3h)` window that gates
    `backend.slots` in `_slot_window`'s caller - and `now` is not a published `UrgencyLevel` member.

So "is it open right now" had no spelling both planes accept: the published word was refused, and the
working word was secret.

What ships is the published word, made true:

  * `IntentTime.type` declares `open_now`, so the member set of the model and the member set of the
    published enum are the same five words - pinned as ONE equality below, which is the leg that
    would have caught this family.
  * `plan_from_intent` reads a ref whose `type` is `open_now` into `plan.open_now`, which is the
    same signal `urgency="now"` sets. The live-hours computation it promises already exists; the
    word for it did not reach it.

Five things this unit does not do, each pinned below:

  * it publishes no vocabulary. `UrgencyLevel` still closes to `low|normal|high` while the service
    writes `now|flexible` - the queued urgency unit; `LocationRefType` still refuses `city`/`nearby`
    and is still refused itself for `mtr_station`/`point`/`current_location`; `BudgetUnit` still
    publishes `total` alone. Only `time.type` is closed here, and the pin says so.
  * it adds no filter to the row lane. `filters.open_now` is not a WHERE clause: the candidate query
    built with `filters={"open_now": True}` is the same text and the same params as without it
    (3175 chars, measured), and `SQL.open_now_predicate_expr` stays unused, where
    `test_no_dead_constants.py:57` already pins it.
  * it teaches the reading lane nothing. No turn the extractor reads writes `open_now`; 「而家」
    still produces `time.type="explicit"` with `quality="now"` and `urgency="now"`. The word is the
    caller's, and this unit only lets the caller say it.
  * it closes no key. `TimeRef` is closed and still has no `quality` - the frame the service emits
    for a clock turn is refused by the published validator for that reason (D710's pin) - and it
    still has a `timezone` the model has no field for.
  * it moves no default. A ref that says nothing is still the null D710 publishes, and a ref that
    says `open_now` AND states a clock keeps the clock's window: the new branch sets a flag, it does
    not choose between them.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.contract import Intent, IntentTime
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search import sql as SQL
from nexus_ai.search.service import _slot_window, plan_from_intent

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = "00000000-0000-0000-0000-000000000001"
INTENT_SCHEMA = json.loads((REPO / "packages/types/src/schemas/intent.json")
                           .read_text(encoding="utf-8"))
PUBLISHED_TYPES = INTENT_SCHEMA["$defs"]["TimeRefType"]["enum"]
FIXTURES = json.loads((REPO / "packages/types/fixtures/intent.json").read_text(encoding="utf-8"))

CAFE = "咖啡店"
#: the ref exactly as the published object requires it: `TimeRef.required` is
#: `["ends_at","starts_at","type"]`, so an honest caller states the window's other edge as null
#: rather than omitting it.
OPEN_NOW_REF = {"type": "open_now", "starts_at": None, "ends_at": None}
#: a fixed clock, so the window the plan opens is a number and not the wall.
NOW = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)
SPOKEN_NOW = "邊間咖啡店而家開唔開"


def _base(**refs) -> dict[str, Any]:
    data = extract_intent_dict(CAFE, {"locale": "zh-HK"})
    data.update({"location": None, "time": None})
    data.update(refs)
    return data


def _model(**refs) -> Intent:
    return Intent.model_validate(_base(**refs))


def _plan(**refs) -> Any:
    return plan_from_intent(_model(**refs), query=CAFE, now=NOW)


def _literals(ann) -> list[str]:
    """The domain an annotation declares, whether it is `Literal[...]` or `Optional[Literal[...]]`."""
    import typing
    if typing.get_origin(ann) is typing.Literal:
        return sorted(str(v) for v in typing.get_args(ann))
    for arg in typing.get_args(ann) or ():
        if typing.get_origin(arg) is typing.Literal:
            return sorted(str(v) for v in typing.get_args(arg))
    return []


def _declared_types() -> list[str]:
    return _literals(IntentTime.model_fields["type"].annotation)


# ------------------------------------------------------------------ the domain, both planes
def test_the_published_enum_names_open_now_and_says_what_it_does():
    assert "open_now" in PUBLISHED_TYPES, PUBLISHED_TYPES
    description = INTENT_SCHEMA["$defs"]["TimeRefType"]["description"]
    assert "live-hours" in description, description


def test_the_model_declares_every_member_the_contract_publishes():
    missing = [v for v in PUBLISHED_TYPES if v not in _declared_types()]
    assert missing == [], f"published words the served model refuses: {missing}"


def test_the_model_declares_no_member_the_contract_does_not_publish():
    extra = [v for v in _declared_types() if v not in PUBLISHED_TYPES]
    assert extra == [], f"words the model accepts and the contract does not publish: {extra}"


def test_the_two_planes_now_name_the_same_five_words():
    assert _declared_types() == sorted(PUBLISHED_TYPES)


# ------------------------------------------------------------------ accepted inbound
def test_the_published_frame_is_accepted_by_the_model():
    intent = _model(time=dict(OPEN_NOW_REF))
    assert intent.time is not None and intent.time.type == "open_now", intent.time


@pytest.mark.parametrize("kind", sorted(PUBLISHED_TYPES))
def test_every_published_member_validates_as_a_time_ref(kind):
    ref = {"type": kind, "starts_at": None, "ends_at": None}
    intent = _model(time=ref)
    assert intent.time is not None and intent.time.type == kind, (kind, intent.time)


def test_the_schemas_own_published_frame_validates():
    """The case `packages/types` ships with `open_now` in it, used as its author used it.

    Its own `expect` is `invalid`, but for a different field: the case description says
    "`cheapest` is not one of the five documented sort preferences", and `expect_rule_ids` is
    `["enum"]` for that. The `time` block inside it is the shape a client copies.
    """
    saying = [c for c in FIXTURES["cases"]
              if ((c.get("instance") or {}).get("time") or {}).get("type") == "open_now"]
    assert len(saying) == 1, saying
    case = saying[0]
    assert "cheapest" in case["description"], case["description"]
    published_time = case["instance"]["time"]
    assert _model(time=published_time).time.type == "open_now", published_time


def test_a_ref_that_says_open_now_is_not_the_ref_that_said_nothing():
    """D710's reader nulls a ref whose every member is falsy; `open_now` is not falsy."""
    assert _model(time=dict(OPEN_NOW_REF)).time is not None
    assert _model(time={"type": None, "starts_at": None, "ends_at": None}).time is None


def test_the_lenient_path_keeps_the_state_it_was_handed():
    """`validate_intent` is what `pipeline.py:105/116` falls back on; None discards the turn.

    Measured before the patch (`tmp/d711_opennow_plan.txt`): the published frame answered None, so
    the route built `Intent(raw_query=query)` and the category, the budget and the district the
    caller carried were gone without an error code.
    """
    intent = validate_intent(_base(time=dict(OPEN_NOW_REF), category="cafe"))
    assert intent is not None, "the published frame was refused and the state dropped silently"
    assert intent.time is not None and intent.time.type == "open_now", intent.time
    assert intent.category == "cafe", intent.category


# ------------------------------------------------------------------ and read
def test_the_published_word_opens_the_hours_filter():
    plan = _plan(time=dict(OPEN_NOW_REF))
    assert plan.open_now is True, plan
    assert plan.filters["open_now"] is True, plan.filters


def test_the_window_it_opens_is_the_next_three_hours():
    plan = _plan(time=dict(OPEN_NOW_REF))
    assert _slot_window(plan) == (NOW, NOW + timedelta(hours=3)), _slot_window(plan)


def test_the_spelling_that_already_worked_still_works():
    plan = _plan(urgency="now")
    assert plan.open_now is True, plan
    assert _slot_window(plan) == (NOW, NOW + timedelta(hours=3)), _slot_window(plan)


def test_the_two_spellings_agree_when_a_caller_says_both():
    both = _plan(time=dict(OPEN_NOW_REF), urgency="now")
    assert both.open_now is True
    assert _slot_window(both) == _slot_window(_plan(urgency="now")), both


def test_a_ref_that_names_a_clock_as_well_keeps_the_clocks_window():
    """`open_now` sets the flag; it does not overrule a stated instant."""
    at = datetime(2026, 11, 6, 19, 0, tzinfo=timezone.utc)
    plan = _plan(time={"type": "open_now", "starts_at": at.isoformat(), "ends_at": None})
    assert plan.open_now is True, plan
    assert plan.at == at, plan.at
    start, end = _slot_window(plan)
    assert (start, end) == (at - timedelta(minutes=30), at + timedelta(hours=2)), (start, end)


def test_a_silent_turn_still_opens_nothing():
    plan = _plan()
    assert plan.open_now is False, plan
    assert _slot_window(plan) is None, _slot_window(plan)


@pytest.mark.parametrize("kind", ["explicit", "relative", "range", "unspecified"])
def test_no_other_published_member_opens_it(kind):
    plan = _plan(time={"type": kind, "starts_at": None, "ends_at": None})
    assert plan.open_now is False, (kind, plan.open_now)
    assert _slot_window(plan) is None, kind


# ------------------------------------------------------------------ not more than the word
def test_the_signal_still_reaches_no_row_filter():
    """Accepting the word must not invent a clause: the candidate query is byte-identical.

    `SQL.open_now_predicate_expr` is the predicate that would do it, and it is unused - already
    pinned as a dead constant by `test_no_dead_constants.py:57`. This unit opens the availability
    window, not a WHERE clause, because that is the computation the description names.
    """
    common = dict(tenant_id=TENANT, text=CAFE, embedding=None)
    without = SQL.build_merchant_query(**common, filters={})
    with_flag = SQL.build_merchant_query(**common, filters={"open_now": True})
    assert with_flag.sql == without.sql, "the plan signal changed the candidate query"
    assert with_flag.params == without.params


def test_the_reading_lane_still_writes_the_urgency_and_not_the_new_word():
    """No turn the extractor reads produces `open_now`; this unit changed the door, not the lane."""
    frame = extract_intent_dict(SPOKEN_NOW, {"locale": "zh-HK"})
    assert frame["time"]["type"] == "explicit", frame["time"]
    assert frame["time"]["quality"] == "now", frame["time"]
    assert frame["urgency"] == "now", frame["urgency"]
    assert _model(time=frame["time"], urgency="now").time.type == "explicit"


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
def test_the_served_route_answers_the_body_the_contract_permits():
    """422 before the patch, on the envelope the route actually sends (`tmp/d711_body422.txt`)."""
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": CAFE, "limit": 3,
                                               "intent": {**_base(), "time": dict(OPEN_NOW_REF)}})
    assert r.status_code == 200, r.text
    assert (r.json()["intent"] or {}).get("time", {}).get("type") == "open_now", r.json()["intent"]


@live_only
def test_the_served_route_still_refuses_a_member_no_plane_publishes():
    """Acceptance is bounded by the published domain, not widened by whatever the door asked for.

    The refusal is the platform envelope, not FastAPI's default `detail`: the handler builds
    `{"error": {"code": "validation_error", "details": {"errors": [...]}}}` and the entries keep the
    body-prefixed loc, `["body","intent","time","type"]` (`tmp/d711_body422.txt`, measured over the
    base bytes). The leg reads the key the route really sends - one that reads `["detail"]` cannot
    fail, because that key is never in the answer.
    """
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": CAFE, "limit": 3,
                                               "intent": {**_base(),
                                                          "time": {"type": "whenever",
                                                                   "starts_at": None,
                                                                   "ends_at": None}}})
    assert r.status_code == 422, r.text
    errors = r.json()["error"]["details"]["errors"]
    assert [tuple(e["loc"]) for e in errors] == [("body", "intent", "time", "type")], errors


# ------------------------------------------------------------------ not this unit's claim
def test_not_this_units_claim_the_urgency_domain_still_has_no_shared_word():
    """Queued, not this unit: published `low|normal|high`, served `now|normal|flexible`, `now` works."""
    from nexus_ai.contract import Intent as I
    level = INTENT_SCHEMA["$defs"]["UrgencyLevel"]["enum"]
    served = extract_intent_dict(SPOKEN_NOW, {"locale": "zh-HK"})["urgency"]
    assert served == "now" and served not in level, (served, level)
    assert _literals(I.model_fields["urgency"].annotation) != sorted(level), level


def test_not_this_units_claim_three_published_location_types_are_still_refused():
    from nexus_ai.contract import IntentLocation
    published = INTENT_SCHEMA["$defs"]["LocationRefType"]["enum"]
    model = _literals(IntentLocation.model_fields["type"].annotation)
    assert sorted(v for v in published if v not in model) == ["current_location", "mtr_station", "point"]
    assert sorted(v for v in model if v not in published) == ["city", "nearby"], model


def test_not_this_units_claim_the_budget_unit_total_is_still_refused():
    from nexus_ai.contract import IntentBudget
    published = INTENT_SCHEMA["$defs"]["BudgetUnit"]["enum"]
    model = _literals(IntentBudget.model_fields["per"].annotation)
    assert "total" in published and "total" not in model, (published, model)


def test_not_this_units_claim_the_closed_ref_still_has_no_place_for_quality():
    """The clock turn's own `quality` is a key `TimeRef` does not declare and the model has a field for."""
    ref = INTENT_SCHEMA["$defs"]["TimeRef"]
    assert "quality" not in ref["properties"] and ref["additionalProperties"] is False
    assert "quality" in IntentTime.model_fields
    assert "timezone" in ref["properties"] and "timezone" not in IntentTime.model_fields
