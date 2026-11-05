"""D710 - a turn that said nothing about place or time sends the null the contract publishes.

`packages/types/src/schemas/intent.json` publishes both refs as `oneOf [ref, null]` and says what
the null means: "Null means the user said nothing about place - the agent asks (spec §8) instead of
using the tenant's default district." `contract.py` built the two fields with a `default_factory`,
so a turn that named no place and read no time dumped an OBJECT whose every member is null - which
is neither branch, because `LocationRef` requires `type` and `LocationRefType` has no null in it.
Measured over 14 ordinary turns before the patch (`tmp/d687_hollow_measure.txt`): the published
validator refused 14 of 14 frames, 27 of those issues on these two paths alone (14 `/time: oneOf`,
13 `/location: oneOf`).

The same `default_factory` decides the other direction too, and that one costs a turn. The shape the
contract permits inbound - `{"location": null}` - is refused by the model, so a caller that follows
the published shape does not get an answer built on its state: `POST /ai/v1/search` with
`intent.location = null` answers 422 at `['body', 'intent', 'location']`
("Input should be a valid dictionary or object to extract fields from"), measured.

And the hollow object breaks a published rule, not only a branch. `rules.mjs:76`'s
`intent_unknowns_are_unsettled` - "a field named in `unknowns` must be null / absent / empty in the
same object, otherwise the extractor guessed and then declared it unknown, which is the exact
failure §8 forbids" - fails on 11 of the 14 measured turns, measured by importing that file and
running it the way `packages/types` runs it rather than by reimplementing the predicate
(`tmp/d687_rule.txt`, `tmp/d687_unknowns.txt`). Nine of the eleven name `location` in `unknowns`
(`understand.py:1292`) while the frame carries something under it: eight send an object of nulls,
which is what this unit replaces with the null the shape describes, and 「set lunch menu near me」
carries a `type` the extractor did guess, which stays. The other two failures name `intent` while
the frame carries `intent="unknown"` - 「lunch buffet」 and 「晏啲得唔得」 - and belong to the
vocabulary, not to these two fields. What the patch leaves is those three, pinned at the bottom.

The same hollow object is read, not only sent. `plan_from_intent` sets
`strip_time=bool(intent is not None and intent.time)` (`search/service.py:984`, again at `:1022`),
and `match_core`'s own docstring states when that may be set: "strip_time is set by the caller when
the time lane PARSED a time: the cue words can be content, so they are not removed on a guess".
`bool()` of a model instance is True whatever it holds, so the live path set it on every turn:
measured, 9 of the 14 turns stripped their time vocabulary with no time behind the strip (the other
5 had parsed one), and for 3 of them the search text changed - 「邊度有午市自助餐」 was searched as
「自助餐」 and 「邊度有午市優惠」
as 「優惠」, and on the live plane 16 of the 20 rows served to each are rows that the word would not
have selected. The extractor's own plain dict is `{}` for the same sentence - falsy - which is the
D652 split opened again by one field default.

What ships is the ref, once, for both directions:

  * `Intent.location` / `Intent.time` are `Optional`, defaulting to absent, so the frame the route
    yields carries the null the published shape already describes; the frame the shape permits is
    accepted inbound; and `bool()` of an empty ref is False, which is what the reader wanted all
    along and the extractor's dict has always said.
  * an empty mapping reads as absent, because the writers (`understand.py:380-381`,
    `state_merger.py:222-223`) send `{}` for 「nothing was said」 and the rule has to hold for the
    frame they produce, not only for a hand-written one. A ref with ANY member set stays the object
    it is - 「沙田嘅咖啡店」 keeps its district, and a ref that read only a `quality` still counts as
    a time, which is exactly how the dict shape already answers both.

Five things this unit does not do, each pinned below:

  * it declares nothing new. `mentioned_entities` and `merchant_id` are still served and still
    outside the closed object - 2 of the frame's keys, 28 refusals across the same 14 turns.
  * it moves no vocabulary. `unknowns` names `intent`, which `UnknownField` does not list;
    `urgency` writes `now`, which `UrgencyLevel` closes to `low|normal|high`; `location.type`
    writes `nearby`, outside `LocationRefType`; `time.quality` is not in the closed `TimeRef`.
  * it asks nothing. `unknowns` is the extractor's list and this unit only changes what the field
    under that name holds. 「午市套餐推荐」 declares `category` as well as `location`, and two of the
    measured turns - 「今晚有冇位」 and 「沙田嘅咖啡店」 - now send a null that nothing names, which the
    published shape permits and no rule requires. Whether every absent ref should be declared is a
    product decision, and it is not this one.
  * it repairs no other inbound shape. `plan_from_intent` still reads `.time` as an attribute at
    `:984` where `:978` uses `_field` for exactly that reason, so the extractor's plain dict still
    raises - the two shapes agree about the ANSWER, not about being accepted.
  * it changes no ranking, score, card or SQL. The clause that reads `plan.match_text` is untouched;
    which word goes into it is what changed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from nexus_ai.contract import Intent
from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search import sql as SQL
from nexus_ai.search.service import plan_from_intent

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = "00000000-0000-0000-0000-000000000001"
INTENT_SCHEMA = json.loads((REPO / "packages/types/src/schemas/intent.json")
                           .read_text(encoding="utf-8"))

SILENT = "午市套餐推荐"
LUNCH = "邊度有午市自助餐"
DEAL = "邊度有午市優惠"
NIGHT = "附近有冇宵夜"
DISTRICT = "沙田嘅咖啡店"
#: the battery `tmp/d687_hollow_measure.txt` ran, kept here so the legs below are the measured turns
BATTERY = [SILENT, "邊度有午市自助餐", "有下午茶嘅餐廳", "想食早餐", NIGHT,
           "set lunch menu near me", "lunch buffet", "找一间安静啲嘅餐厅", DISTRICT,
           "今晚有冇位", "晏啲得唔得", "朝早開嘅咖啡店", "推薦間餐廳", DEAL]
#: a turn-1 state in the shape the stream's own `intent` frame hands back
TURN1: dict[str, Any] = {"raw_query": "咖啡店", "intent": "discover_merchant",
                         "category": "cafe", "language": "zh-HK"}
#: the three `intent_unknowns_are_unsettled` failures this unit leaves standing, measured
#: turn by turn before and after the refs go nullable (`tmp/d687_rule.txt`)
RULE_RESIDUAL = {"lunch buffet": ["intent"], "晏啲得唔得": ["intent"],
                 "set lunch menu near me": ["location"]}


def _declared_but_carried(wire: dict[str, Any]) -> list[str]:
    """The published rule's own predicate, copied from `rules.mjs:86` rather than re-invented.

    It is written here because the rule lives in `packages/types` and no CI runs it over an intent
    frame (`verify_payload_conformance.mjs` never reads one) - which is filed, not fixed.
    """
    return [field for field in wire["unknowns"]
            if not (wire.get(field) is None
                    or (isinstance(wire.get(field), list) and not wire.get(field)))]


def _frame(text: str) -> dict[str, Any]:
    return extract_intent_dict(text, {"locale": "zh-HK"})


def _model(text: str) -> Intent:
    return Intent.model_validate(_frame(text))


def _wire(text: str) -> dict[str, Any]:
    """The frame `api/stream.py:107` yields: the model, dumped the way the route dumps it."""
    return _model(text).model_dump(mode="json")


# --------------------------------------------------------------- the frame that goes out
def test_a_turn_that_said_nothing_sends_the_null_the_shape_publishes():
    wire = _wire(SILENT)
    assert wire["location"] is None, wire["location"]
    assert wire["time"] is None, wire["time"]
    # `required` names both, so the promise is a null on the wire rather than a missing key
    assert {"location", "time"} <= set(INTENT_SCHEMA["required"])
    assert "location" in wire and "time" in wire


@pytest.mark.parametrize("ref,branch", [("location", "LocationRef"), ("time", "TimeRef")])
def test_the_published_branches_are_the_object_or_null_and_the_null_is_sent(ref, branch):
    published = INTENT_SCHEMA["properties"][ref]["oneOf"]
    assert {"type": "null"} in published, published
    target = INTENT_SCHEMA["$defs"][branch]
    assert target["additionalProperties"] is False
    assert "type" in target["required"], target["required"]
    #: why the hollow object matched neither branch: the object needs a `type` and its enum has no null
    kind = INTENT_SCHEMA["$defs"][target["properties"]["type"]["$ref"].rsplit("/", 1)[1]]
    assert None not in kind["enum"], kind["enum"]
    assert _wire(SILENT)[ref] is None, f"{ref} is sent as an object of nulls"


@pytest.mark.parametrize("text", BATTERY)
def test_no_served_frame_leaves_a_ref_that_says_nothing(text):
    """Every turn answers each ref with either nothing to say or something said - never both."""
    wire = _wire(text)
    for ref in ("location", "time"):
        value = wire[ref]
        if value is None:
            continue
        assert any(value.values()), f"{text}: {ref} is an object whose members all say nothing"


def test_the_served_frame_still_carries_every_field_the_contract_requires():
    wire = _wire(SILENT)
    missing = [k for k in INTENT_SCHEMA["required"] if k not in wire]
    assert not missing, missing


def test_the_contract_says_what_the_null_means():
    """The published description is the product rule this unit makes true, not a comment.

    Quoted as a substring because the sentence goes on with an em dash and a § reference; the gate
    reads the shipped bytes, so the pin is the words the shape itself carries.
    """
    description = INTENT_SCHEMA["properties"]["location"]["description"]
    assert "Null means the user said nothing about place" in description, description
    assert "default district" in description, description


# --------------------------------------------------------------- the shape that comes in
def test_the_shape_the_contract_publishes_is_accepted_inbound():
    """`location: null` is a legal intent object; the model used to refuse its own contract."""
    intent = Intent.model_validate({**TURN1, "location": None, "time": None})
    assert intent.location is None and intent.time is None


def test_the_frame_the_service_sends_round_trips_through_the_service():
    wire = _wire(LUNCH)
    again = Intent.model_validate(wire).model_dump(mode="json")
    assert again == wire, {k: (wire[k], again[k]) for k in wire if wire[k] != again.get(k)}


def test_the_writers_empty_mapping_reads_as_the_same_nothing():
    """`understand.py:380` and `state_merger.py:222` send `{}` for 「nothing was said」."""
    intent = Intent.model_validate({**TURN1, "location": {}, "time": {}})
    assert intent.location is None, intent.location
    assert intent.time is None, intent.time


def test_a_previous_intent_written_in_the_published_shape_keeps_its_turn(client):
    """The browser's own echo: a state whose refs are null must not be refused at the door."""
    r = client.post("/ai/v1/search", json={"query": "午市自助餐", "limit": 3,
                                           "intent": {**TURN1, "location": None, "time": None}})
    assert r.status_code == 200, r.text
    assert r.json()["intent"]["category"] == "cafe", r.json()["intent"]


# --------------------------------------------------------------- a ref that says something
def test_a_district_the_user_named_still_reaches_the_filter():
    intent = _model(DISTRICT)
    assert intent.location is not None and intent.location.type == "district"
    assert intent.location.value == "Sha Tin", intent.location
    plan = plan_from_intent(intent, query=DISTRICT)
    assert plan.filters.get("district") == "Sha Tin", plan.filters


def test_a_partly_filled_ref_is_not_flattened():
    """The guard is 「every member says nothing」, not 「any member says nothing」."""
    intent = Intent.model_validate({**TURN1, "location": {"type": None, "value": "旺角",
                                                         "resolved": None, "radius_m": None}})
    assert intent.location is not None, "a place the user named was read as silence"
    assert intent.location.value == "旺角"
    assert intent.location.type is None


def test_a_time_that_read_only_a_quality_is_still_a_time():
    """`quality` with no band is what the time lane writes for a qualitative cue, and the
    extractor's own dict is non-empty for it - so the model must not call it silence."""
    intent = Intent.model_validate({**TURN1, "time": {"type": None, "starts_at": None,
                                                      "ends_at": None, "raw": None,
                                                      "quality": "night"}})
    assert intent.time is not None and intent.time.quality == "night"


@pytest.mark.parametrize("text", BATTERY)
def test_the_model_and_the_extractors_dict_agree_about_what_was_said(text):
    """One fact, one answer: `bool()` of the ref is the same for both shapes of the same turn.

    `plan_from_intent` accepts either (D652), and read them differently: a `{}` is falsy and an
    `IntentLocation()` is not, which is what set `strip_time` on a guess for every live turn.
    """
    frame = _frame(text)
    intent = Intent.model_validate(frame)
    assert bool(intent.location) == bool(frame.get("location")), (text, frame.get("location"))
    assert bool(intent.time) == bool(frame.get("time")), (text, frame.get("time"))


# --------------------------------------------------------------- the reader that guessed
def test_a_turn_that_read_no_time_keeps_the_word_that_named_the_occasion():
    """「午市」 is content when the time lane read no time: it is the thing being asked for."""
    assert not _frame(LUNCH)["time"], _frame(LUNCH)["time"]
    plan = plan_from_intent(_model(LUNCH), query=LUNCH)
    assert "午市" in plan.match_text, plan.match_text


@live_only
def test_the_lunch_word_divides_the_live_page_it_is_searched_with():
    """Not a cosmetic text: the word changes which rows the corpus answers.

    Measured on the same pool, filters and geo (`tmp/d687_hollow_measure.txt`): the two texts share
    4 of 20 rows for 「邊度有午市自助餐」 and for 「邊度有午市優惠」.
    """
    plan = plan_from_intent(_model(LUNCH), query=LUNCH)
    kept = canonical(plan.match_text) or None
    assert kept and "午市" in kept, plan.match_text
    stripped = canonical(kept.replace("午市", "")) or None
    ids = {}
    for name, text in (("kept", kept), ("stripped", stripped)):
        q = SQL.build_merchant_query(tenant_id=TENANT, text=text, embedding=None,
                                     filters=plan.filters, geo=plan.geo,
                                     radius_m=plan.radius_m, limit=20)
        ids[name] = [str(r["id"]) for r in _readonly(q)]
    assert set(ids["kept"]) != set(ids["stripped"]), ids


def test_a_turn_that_did_read_a_time_still_loses_its_cue():
    """The strip the docstring allows is untouched: a parsed time still takes its own words out."""
    assert _frame(NIGHT)["time"]["type"] == "range", _frame(NIGHT)["time"]
    plan = plan_from_intent(_model(NIGHT), query=NIGHT)
    assert "宵夜" not in plan.match_text, plan.match_text


def test_the_deal_turn_keeps_its_occasion_word_too():
    plan = plan_from_intent(_model(DEAL), query=DEAL)
    assert "午市" in plan.match_text, plan.match_text


def _readonly(statement) -> list[dict[str, Any]]:
    """Rows for a built statement on the plane this test session is allowed to use."""
    import asyncio

    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def drive():
        settings = Settings(llm_provider="mock", embedding_provider="hashing",
                            database_url=DB_URL, internal_token="")
        db = await db_pool.connect(settings, force_new=True)
        try:
            return [dict(r) for r in await db.readonly(statement.sql, *statement.params)]
        finally:
            await db.close()

    return asyncio.run(drive())


# --------------------------------------------------------------- served, live plane
def _live_client():
    from fastapi.testclient import TestClient

    from contextlib import contextmanager

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
def test_the_live_frame_sends_null_for_a_turn_that_said_nothing():
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": LUNCH, "limit": 4})
        assert r.status_code == 200, r.text
    intent = r.json()["intent"]
    assert intent["location"] is None, intent["location"]
    assert intent["time"] is None, intent["time"]


@live_only
def test_the_live_plane_accepts_the_shape_it_publishes():
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": "午市自助餐", "limit": 3,
                                               "intent": {**TURN1, "location": None,
                                                          "time": None}})
    assert r.status_code == 200, r.text
    assert r.json()["intent"]["category"] == "cafe", r.json()["intent"]


# --------------------------------------------------------------- not this unit's claim
def test_not_this_units_claim_two_keys_are_still_outside_the_closed_object():
    """2 of the frame's keys, and 28 refusals across the battery (`tmp/d687_hollow_measure.txt`)."""
    served = set(_wire(SILENT))
    refused = sorted(served - set(INTENT_SCHEMA["properties"]))
    assert refused == ["mentioned_entities", "merchant_id"], refused


def test_not_this_units_claim_unknowns_names_a_field_the_shape_does_not_know():
    unknowns = INTENT_SCHEMA["$defs"]["UnknownField"]["enum"]
    named = {u for text in BATTERY for u in _wire(text)["unknowns"]}
    assert "intent" in named and "intent" not in unknowns, (named, unknowns)


def test_not_this_units_claim_the_urgency_a_clock_turn_writes_is_outside_the_published_domain():
    level = INTENT_SCHEMA["$defs"]["UrgencyLevel"]["enum"]
    assert _wire("今晚有冇位")["urgency"] == "now", _wire("今晚有冇位")["urgency"]
    assert "now" not in level, level


def test_not_this_units_claim_the_time_lane_writes_a_key_the_closed_ref_refuses():
    ref = INTENT_SCHEMA["$defs"]["TimeRef"]
    assert "quality" not in ref["properties"] and ref["additionalProperties"] is False
    with_quality = [t for t in BATTERY if (_wire(t)["time"] or {}).get("quality")]
    assert with_quality, "no turn in the battery writes `quality`"


def test_not_this_units_claim_nearby_is_a_published_location_type():
    kinds = INTENT_SCHEMA["$defs"]["LocationRefType"]["enum"]
    located = _wire(NIGHT)["location"]
    assert located is not None and located["type"] == "nearby", located
    assert "nearby" not in kinds, kinds


def test_not_this_units_claim_the_extractors_plain_dict_still_cannot_be_planned():
    """`service.py:984` reads `.time` as an attribute where `:978` uses `_field` for that reason."""
    with pytest.raises(AttributeError):
        plan_from_intent(_frame(SILENT), query=SILENT)


@pytest.mark.parametrize("text", BATTERY)
def test_a_ref_the_turn_declared_unknown_is_either_null_or_says_something(text):
    """§8's promise, turn by turn: 「I do not know the place」 and a place object cannot both hold."""
    wire = _wire(text)
    for ref in ("location", "time"):
        if ref not in wire["unknowns"]:
            continue
        value = wire[ref]
        assert value is None or any(value.values()), (
            f"{text}: {ref} is declared unknown and sent as an object whose every member is null")


def test_the_rule_still_fails_on_the_three_turns_this_unit_does_not_touch():
    """The residue, pinned so the day it moves this door asks for a new number.

    Two turns declare `intent` unknown while the frame answers `intent="unknown"` - the word is
    the fallback, not a guess, and the field's own domain is the next unit's question - and
    「set lunch menu near me」 declares `location` unknown while its ref carries the one type the
    extractor did read. Measured: 11 failures before this unit, 3 after (`tmp/d687_rule.txt`).
    """
    failures = {t: _declared_but_carried(_wire(t)) for t in BATTERY
                if _declared_but_carried(_wire(t))}
    assert failures == RULE_RESIDUAL, failures
