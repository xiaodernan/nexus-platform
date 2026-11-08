"""D676 - the follow-up that asks for others keeps the turn it carried and leaves the rows shown.

`state_merger.py` read the ALT cues (其他 / 換一間 / next / more options / 還有) and wrote the rows the
surface had already shown into `base["filters"]["exclude"]`. `Intent` is `_Strict`
(`extra="forbid"`, `contract.py:258`) and the published `packages/types/src/schemas/intent.json`
closes the same object with `additionalProperties: false`, so the key that write added was refused
by both: `pipeline.py:116` asked `validate_intent` for the merged turn, got `None`, and answered
`floor("state_merge_rejected")` - a fresh extraction of the cue's own words. The exclusion was never
read either: `plan_from_intent` builds the filters the two candidate reads use, and named no such
field. Measured over `7e8ca97` before the patch (`tmp/d676_measure.txt`, record):

  * the cue with NOTHING shown still gains the key, so the turn fails its own model anyway -
    `filters: {}`, `validate_intent -> NoneType` (§4). Nothing had to be excluded for the answer to
    lose the turn: `setdefault` ran outside the `if seen` guard.
  * served over `/ai/v1/search/stream`, turn 1 「咖啡店」 answered `category='cafe'` and four ids; turn 2
    「其他」 carried that state in and answered `raw_query='其他'`, `category=None`, `intent='unknown'` -
    the turn-1 category gone, and a full-text search for the word 其他 in its place (§5).
  * the read has cut on this key for a whole unit: `build_merchant_query` adds
    `m.id::text <> ALL($n::text[])` and `build_offering_query` the `o.` mirror, the fixture lane
    mirrors both (`service.py` `_filter_static`), and D617's door proves the cut on real corpus ids.
    Only the state's field and the planner's fold were missing (§3, §7 - no gate reaches the key
    through `SearchRequestFilters`, and none through the intent either).

What ships is the road, not a new predicate:

  * `Intent.excluded_ids: list[str]` - declared, so the merged state validates and the field
    travels back as `previous_intent`. The state is the ONLY thing that survives between turns (the
    client carries it), so an exclusion held anywhere else is forgotten by turn 3; that is also why
    the cue grows the list instead of replacing it.
  * `state_merger` unions `context.shown_ids` into it and records the change with the field it
    actually changed (`{"op": "exclude", "field": "excluded_ids", "from": 1, "to": 2}`), which is
    what §34 asks of the record: an `agent_run` should be able to say what turn three did.
  * `plan_from_intent` folds it into `filters.exclude`, the key both reads already implement, next
    to the way `constraints` fold into `avoid` and `location` into `district` - the planner stays
    the one reader of the intent's fields.
  * the published shape goes with it: `intent.ts`, `schemas/intent.json` (closed) and
    `API_CONTRACT` §7.1. A field the served `intent` frame carries and the published closed object
    refuses is D643's defect, and this unit is not going to create another one.

Six things this unit does NOT do, each pinned at the bottom so the day it changes the pin goes red
and asks for a new door:

  * it declares nothing on `SearchRequestFilters`. Seven keys the reads act on are undeclared there
    and each is a served 422 (`tmp/d676_measure.txt` §2), but six of them - `open_time`, `open_until`,
    `open_weekday`, `min_closing_hour`, `max_opening_hour`, `category_spelling` - are the PLAN's own
    vocabulary, written by `plan_from_intent` from the intent's time and category, not asked of the
    caller. `exclude` is the one that a caller could honestly name; it needs a decision about the
    request's contract, not a line in a model.
  * it teaches the console nothing. `apps/web/app/api/nexus/ai/stream/route.ts` builds `context` as
    `{geo, locale, now}` and never sends `shown_ids`, so the browser's 「其他」 now keeps the turn it
    carried - the defect this unit closes - and still shows the same rows again, because nothing has
    told the server which ones those were.
  * it inherits through the re-extract branch. D676 filed the omission as an open product
    question (§B of `tmp/d676_measure_after.txt`); D793 closed it as the one decision `§34`'s
    own words carry - the exclusion is a memory the new turn did not contradict, exactly as
    `party_size` / `location` / `budget` / `constraints` / `preferences` are, and the state is the
    only memory between turns. `_overlay` now keeps the carry; the measured pin lives at
    `test_a_re_extract_turn_carries_the_exclusion_forward`.
  * it sends no field the published schema refuses. The served frame still carries
    `mentioned_entities` and `merchant_id`, which `intent.json` does not declare - 2 of 17 keys,
    measured in §E - and closing that is its own unit.
  * it changes no ranking, no score, no card. Which rows ANSWER a request is unchanged for every
    request that carries no exclusion; the cut only happens for the turn that names ids.
  * it guesses nothing. An ALT cue with nothing shown states no exclusion (`[]`) rather than
    inventing ids, exactly as §8 forbids inventing a budget.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.api.sse import parse_frames
from nexus_ai.contract import Intent
from nexus_ai.nlu.state_merger import ALT_CUES, merge_turn
from nexus_ai.search.service import StaticBackend, plan_from_intent
from nexus_ai.search import sql as SQL

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = "00000000-0000-0000-0000-000000000001"
#: a turn-1 state in the shape the stream's own `intent` frame hands back
TURN1: dict[str, Any] = {"raw_query": "咖啡店", "intent": "discover_merchant",
                         "category": "cafe", "language": "zh-HK",
                         "budget": {"min": None, "max": 300, "currency": "HKD", "per": "party"}}
SHOWN = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]

INTENT_TS = (REPO / "packages/types/src/intent.ts").read_text(encoding="utf-8")
INTENT_SCHEMA = json.loads((REPO / "packages/types/src/schemas/intent.json")
                           .read_text(encoding="utf-8"))
API_CONTRACT = (REPO / "docs/API_CONTRACT.md").read_text(encoding="utf-8")
BFF_ROUTE = (REPO / "apps/web/app/api/nexus/ai/stream/route.ts").read_text(encoding="utf-8")


def _merged(turn: str, state: dict[str, Any] | None = None,
            shown: list[str] | None = None):
    return merge_turn(dict(state if state is not None else TURN1), turn,
                      {} if shown is None else {"shown_ids": shown})


# --------------------------------------------------------------- the state the cue leaves
def test_the_cue_that_asks_for_others_leaves_a_state_the_model_accepts():
    """The whole point: the merged turn must survive the model that judges it.

    Before this unit, every spelling of every ALT cue returned `None` here - `pipeline.py:116`
    then answered `floor("state_merge_rejected")` and the turn lost the category it carried.
    """
    assert ALT_CUES, "the cue table is empty, so nothing below can be measured"
    for cue in ALT_CUES:
        merged = _merged(cue, shown=SHOWN)
        intent = validate_intent(merged.intent)
        assert isinstance(intent, Intent), f"{cue!r}: {merged.intent.keys()}"
        assert "filters" not in merged.intent, f"{cue!r}: the poison key is back"
        assert intent.category == "cafe", f"{cue!r}: the turn-1 category did not survive"


def test_the_cue_with_nothing_shown_still_leaves_a_state_the_model_accepts():
    """The 422-shaped half of the defect: nothing had to be excluded for the turn to break.

    `base.setdefault("filters", {})` ran outside the `if seen:` guard, so an empty `filters` dict
    landed in the state and the strict model refused it anyway (`tmp/d676_measure.txt` §4).
    """
    merged = _merged("其他", shown=[])
    assert "filters" not in merged.intent
    assert validate_intent(merged.intent) is not None


def test_the_exclusion_lands_on_the_field_the_model_declares():
    merged = _merged("其他", shown=[SHOWN[1], SHOWN[0], SHOWN[0]])
    assert merged.intent["excluded_ids"] == sorted(SHOWN), merged.intent["excluded_ids"]


def test_a_second_others_turn_grows_the_list_it_was_carried():
    """The state is the only thing that travels, so the exclusion has to accumulate."""
    second = _merged("next", shown=SHOWN)
    third = _merged("其他", state=second.intent, shown=["33333333-3333-4333-8333-333333333333"])
    assert third.intent["excluded_ids"] == sorted([*SHOWN,
                                                   "33333333-3333-4333-8333-333333333333"])
    assert validate_intent(third.intent).excluded_ids == third.intent["excluded_ids"]


def test_the_change_record_names_the_field_it_changed():
    """§34: an `agent_run` must be able to say what the turn did to the filters."""
    first = _merged("其他", shown=SHOWN).changes
    op = [c for c in first if c.get("op") == "exclude"]
    assert len(op) == 1, first
    assert op[0]["field"] == "excluded_ids", op[0]
    assert (op[0]["from"], op[0]["to"]) == (0, 2), op[0]
    grown = [c for c in _merged("其他", state=_merged("其他", shown=SHOWN[:1]).intent,
                                shown=SHOWN).changes if c.get("op") == "exclude"]
    assert (grown[0]["from"], grown[0]["to"]) == (1, 2), grown[0]


def test_a_long_new_question_after_an_others_ask_carries_the_exclusion_forward():
    """The D676 §B leftover, closed here.

    The re-extract branch used to answer a state without the exclusion after a long turn: 33
    codepoints of new Mandarin after 「其他」 answered `excluded_ids: null` when the turn before
    it had `[a1, b2]` to hold (§B of `tmp/d676_measure_after.txt`). The exclusion is the ONE
    memory that outlives the turn that made it (`§34`: the state is the ONLY thing that survives
    between turns), and a new question contradicts nothing about which rows were shown. The
    re-extract branch now inherits it, exactly as it inherits `party_size` / `location` / `budget` /
    `constraints` / `preferences` - memory the new turn does not contradict stays.
    """
    state = _merged("其他", shown=SHOWN).intent
    long_turn = "我想找沙田的一家安静餐厅吃熊肉火锅和日本寿司omakase或者烧肉"
    after = _merged(long_turn, state=state, shown=[]).intent
    assert sorted(after.get("excluded_ids") or []) == sorted(SHOWN), after.get("excluded_ids")
    assert after["category"] == "hotpot", after
    assert validate_intent(after) is not None
    assert validate_intent(after).excluded_ids == after["excluded_ids"]


def test_a_cue_with_nothing_shown_invents_no_exclusion():
    """§8's discipline applied to ids: nothing stated, nothing recorded.

    The merged dict states no exclusion at all - not an empty list the writer invented - and the
    model fills its own default, which is what a closed object means by absence.
    """
    merged = _merged("其他", shown=[])
    assert merged.intent.get("excluded_ids") in (None, []), merged.intent.get("excluded_ids")
    assert validate_intent(merged.intent).excluded_ids == []
    assert not [c for c in merged.changes if c.get("op") == "exclude"], merged.changes


def test_the_words_of_the_user_stay_the_users_own():
    """The cue is a turn, not a reset: the sentence it carries is the one it was asked with."""
    merged = _merged("換一間", shown=SHOWN)
    assert "換一間" in merged.intent["raw_query"], merged.intent["raw_query"]


# --------------------------------------------------------------- the plan and the two reads
def test_the_planner_folds_the_states_exclusion_into_the_filter_the_reads_cut_on():
    intent = validate_intent(_merged("其他", shown=SHOWN).intent)
    plan = plan_from_intent(intent, query="其他")
    assert plan.filters.get("exclude") == sorted(SHOWN), plan.filters


def test_a_state_with_nothing_to_skip_states_no_filter():
    """An empty exclusion writes no key: `if filters.get("exclude")` is the read's own test."""
    plan = plan_from_intent(validate_intent(_merged("其他", shown=[]).intent), query="其他")
    assert "exclude" not in plan.filters, plan.filters


def test_the_callers_own_exclude_list_survives_the_fold():
    """A direct caller's `filters` is kept and the state's ids merge in - deduped, order-stable."""
    intent = validate_intent(_merged("其他", shown=["b", "c"]).intent)
    plan = plan_from_intent(intent, query="其他", filters={"exclude": ["a", "b"]})
    assert plan.filters["exclude"] == ["a", "b", "c"], plan.filters


def test_the_merchant_select_cuts_the_excluded_rows():
    plan = plan_from_intent(validate_intent(_merged("其他", shown=SHOWN).intent), query="其他")
    q = SQL.build_merchant_query(tenant_id=TENANT, text=None, embedding=None,
                                 filters=plan.filters, limit=20)
    assert "m.id::text <> ALL(" in q.sql, q.sql
    assert all(s not in q.params for s in SHOWN), "the ids bound twice"


def test_the_offering_select_cuts_the_excluded_rows():
    """The offering lane carries the mirror clause and no vector leg (`build_offering_query` takes
    no `embedding`) - the same exclusion answered by both subject types."""
    plan = plan_from_intent(validate_intent(_merged("其他", shown=SHOWN).intent), query="其他")
    q = SQL.build_offering_query(tenant_id=TENANT, text=None, filters=plan.filters, limit=20)
    assert "o.id::text <> ALL(" in q.sql, q.sql


def test_the_fixture_lane_answers_the_same_exclusion_question():
    """`_filter_static` reads `filters.exclude`; the plan now hands it something to read."""
    rows = [{"id": "m-a", "subject_id": "m-a", "name": "A", "category": "cafe",
             "status": "published", "tenant_id": TENANT},
            {"id": "m-b", "subject_id": "m-b", "name": "B", "category": "cafe",
             "status": "published", "tenant_id": TENANT}]
    plan = plan_from_intent(validate_intent(_merged("其他", shown=["m-a"]).intent), query="其他")
    kept = asyncio.run(StaticBackend(merchants=rows).merchant_candidates(text="",
                                                                        filters=plan.filters))
    assert [r["id"] for r in kept] == ["m-b"], kept


def test_the_fixture_lane_drops_an_excluded_offering():
    rows = [{"id": "o-a", "subject_id": "o-a", "name": "A", "category": "cafe",
             "status": "active", "tenant_id": TENANT},
            {"id": "o-b", "subject_id": "o-b", "name": "B", "category": "cafe",
             "status": "active", "tenant_id": TENANT}]
    plan = plan_from_intent(validate_intent(_merged("其他", shown=["o-a"]).intent), query="其他")
    kept = asyncio.run(StaticBackend(offerings=rows).offering_candidates(text="",
                                                                        filters=plan.filters))
    assert [r["id"] for r in kept] == ["o-b"], kept


# --------------------------------------------------------------- the published shape
def test_the_intent_model_declares_the_field_as_a_list_of_ids():
    field = Intent.model_fields["excluded_ids"]
    assert field.annotation == list[str], field.annotation
    assert Intent(raw_query="x").excluded_ids == []
    assert "filters" not in Intent.model_fields, "a second home for the exclusion came back"


def test_the_published_schema_declares_the_field_the_frame_carries():
    assert INTENT_SCHEMA.get("additionalProperties") is False, "the closed object opened"
    prop = INTENT_SCHEMA["properties"]["excluded_ids"]
    assert prop["type"] == "array" and prop["items"]["type"] == "string", prop
    served = set(Intent.model_validate(_merged("其他", shown=SHOWN).intent).model_dump())
    assert "excluded_ids" in served, sorted(served)


def test_the_published_types_and_the_contract_doc_name_it():
    assert re.search(r"excluded_ids\?\s*:\s*string\[\]", INTENT_TS), "intent.ts dropped the field"
    section = API_CONTRACT.split("### 7.1 Intent", 1)[1].split("## 8.", 1)[0]
    assert "excluded_ids" in section, "API_CONTRACT §7.1 no longer states the field"
    assert "shown_ids" in section, "§7.1 no longer says where the exclusion comes from"


# --------------------------------------------------------------- served, demo plane
def _stream_turn(client, query: str, previous: dict | None, shown: list[str] | None):
    """One turn of the documented stream: the cue, the state carried into it, and `shown_ids` -
    the surface's own list of what it has already rendered."""
    context: dict[str, Any] = {"locale": "zh-HK"}
    if shown is not None:
        context["shown_ids"] = shown
    r = client.post("/ai/v1/search/stream", json={"query": query, "previous_intent": previous,
                                                  "context": context, "limit": 4})
    assert r.status_code == 200, r.text
    frames = parse_frames(r.text)
    intent = next(d for name, d in frames if name == "intent")
    items = next(d for name, d in frames if name == "results")["items"]
    return intent, [c["id"] for c in items]


def test_the_served_stream_keeps_the_turn_and_leaves_the_rows_it_shown(client):
    intent1, ids1 = _stream_turn(client, "quiet cafe", None, None)
    assert intent1["excluded_ids"] == [], "a first turn invented an exclusion"
    intent2, ids2 = _stream_turn(client, "其他", intent1, ids1)
    assert intent2["category"] == intent1["category"], (intent1["category"], intent2["category"])
    assert "其他" in intent2["raw_query"] and intent2["raw_query"] != "其他", intent2["raw_query"]
    assert sorted(intent2["excluded_ids"]) == sorted(ids1), intent2["excluded_ids"]
    assert not (set(ids1) & set(ids2)), f"the second page re-shows {sorted(set(ids1) & set(ids2))}"


def test_the_served_stream_with_nothing_shown_keeps_the_turn(client):
    """The browser's exact position today: the cue arrives, the ids do not.

    Before this unit the answer was a search for the word 其他 with no category at all.
    """
    intent1, _ids1 = _stream_turn(client, "quiet cafe", None, None)
    intent2, ids2 = _stream_turn(client, "其他", intent1, None)
    assert intent2["category"] == intent1["category"]
    assert intent2["excluded_ids"] == []
    assert ids2, "the cue that could not exclude anything answered nothing at all"


def test_the_json_door_honours_an_exclusion_carried_on_the_intent(client):
    first = client.post("/ai/v1/search", json={"query": "quiet cafe", "limit": 4})
    assert first.status_code == 200, first.text
    ids = [c["id"] for c in first.json()["items"]]
    r = client.post("/ai/v1/search", json={"query": "quiet cafe", "limit": 4, "intent": {
        "raw_query": "quiet cafe · 其他", "intent": "discover_merchant",
        "category": "cafe", "excluded_ids": ids[:2]}})
    assert r.status_code == 200, r.text
    assert not set(ids[:2]) & {c["id"] for c in r.json()["items"]}


# --------------------------------------------------------------- served, live plane
def _live_client():
    """A client over the real plane, refused rather than substituted.

    `app.py:54` degrades to the offline demo catalogue when the pool is unreachable, so a leg that
    counts live rows would otherwise be answered by a plane that has none of them - and a demo
    answer to 「excluding four rows left no answer at all」 is a lie about the live corpus, not a
    failure of it. The plane is asked out loud before any leg is allowed to trust its rows.
    """
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
def test_the_live_stream_second_turn_leaves_the_rows_it_shown():
    with _live_client() as client:
        intent1, ids1 = _stream_turn(client, "咖啡店", None, None)
        assert len(ids1) == 4, ids1
        intent2, ids2 = _stream_turn(client, "其他", intent1, ids1)
    assert intent2["category"] == "cafe", intent2
    assert sorted(intent2["excluded_ids"]) == sorted(ids1)
    assert not set(ids1) & set(ids2), f"{sorted(set(ids1) & set(ids2))} served twice"


@live_only
def test_the_live_plane_cut_is_of_a_row_that_was_otherwise_served():
    """Not a synthetic id: the row the exclusion names is one the same query answers without it.

    `tmp/d676_measure.txt` §6 excluded five ids the corpus does not carry and so proved nothing;
    this asks the live plane for its own first page and removes one row from the middle of it.
    """
    from nexus_ai.db import pool as db_pool
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")

    async def drive():
        db = await db_pool.connect(settings, force_new=True)
        try:
            def ask(exclude: list[str]):
                return SQL.build_merchant_query(tenant_id=TENANT, text="咖啡店", embedding=None,
                                                filters={"category": "cafe", "exclude": exclude},
                                                limit=20)
            plain = ask([])
            first = await db.readonly(plain.sql, *plain.params)
            drop = str(first[2]["id"])
            cut = ask([drop])
            second = await db.readonly(cut.sql, *cut.params)
            return [str(r["id"]) for r in first], drop, [str(r["id"]) for r in second]
        finally:
            await db.close()

    page, dropped, after = asyncio.run(drive())
    assert dropped in page
    assert dropped not in after, "the clause named the row and the plane served it anyway"
    assert len(after) == len(page), f"the cut cost more than the one row: {len(page)} -> {len(after)}"


@live_only
def test_the_live_json_door_drops_an_excluded_merchant():
    with _live_client() as client:
        r = client.post("/ai/v1/search", json={"query": "咖啡店", "limit": 4})
        ids = [c["id"] for c in r.json()["items"]]
        r2 = client.post("/ai/v1/search", json={"query": "咖啡店", "limit": 4, "intent": {
            "raw_query": "咖啡店 · 其他", "intent": "discover_merchant", "category": "cafe",
            "excluded_ids": ids}})
        assert r2.status_code == 200, r2.text
        assert r2.json()["items"], "excluding four rows left no answer at all"
        assert not set(ids) & {c["id"] for c in r2.json()["items"]}


# --------------------------------------------------------------- not this unit's claim
def test_not_this_units_claim_a_body_naming_exclude_in_filters_is_refused():
    """`filters.exclude` is the read's own key and the request model still forbids it.

    Measured: 422 `extra_forbidden` at `['body','filters','exclude']`, including for the ids the
    server just showed (`tmp/d676_measure.txt` §2). Declaring it needs a decision about what the
    request's `filters` are for - the other six undeclared keys are the plan's vocabulary, not the
    caller's - so it is filed, not guessed.
    """
    from pydantic import ValidationError

    from nexus_ai.contract import SearchRequestFilters
    with pytest.raises(ValidationError) as caught:
        SearchRequestFilters(exclude=SHOWN)
    assert [e["type"] for e in caught.value.errors()] == ["extra_forbidden"]


def test_not_this_units_claim_the_console_sends_no_shown_ids():
    """The BFF builds `context` as `{geo, locale, now}` - the ids the page rendered stay there.

    So the browser's 「其他」 keeps its turn from this unit onward and still repeats its rows until
    somebody sends the ids. Pinned here so the road is not mistaken for walked.
    """
    assert "shown_ids" not in BFF_ROUTE, "the BFF began to send them - this pin and its PLAN entry"
    assert re.search(r"context:\s*\{[^}]*now", BFF_ROUTE), "the BFF's context changed shape"


def test_a_re_extract_turn_carries_the_exclusion_forward():
    """The re-extract branch used to drop it. §34 says the state is the only memory.

    D676 filed this as an open product question (§B of `tmp/d676_measure_after.txt`), and D793
    closed it as the one decision §34's own words carry: the exclusion is a memory the new turn
    did not contradict, exactly as `party_size` / `location` / `budget` / `constraints` /
    `preferences` are. `_overlay` keeps the carry; a new question fires no `exclude` cue here
    because the show-ids mechanism is the client's, not the turn's.
    """
    merged = _merged("我想找一個安靜嘅餐廳，預算300，不要海鮮，香港人開嘅",
                     state={**TURN1, "excluded_ids": ["state-1"]})
    assert validate_intent(merged.intent) is not None
    assert validate_intent(merged.intent).excluded_ids == ["state-1"]

def test_not_this_units_claim_the_frame_sends_two_keys_the_schema_refuses():
    """`mentioned_entities` and `merchant_id` are served and undeclared - 2 of 17 (§E).

    This unit declared its own field rather than adding a third, but the closed object still
    refuses these two, so a consumer that validates the frame against `intent.json` fails on a
    turn that named an entity. Its own door, not this claim.
    """
    served = set(Intent.model_validate(_merged("其他", shown=SHOWN).intent).model_dump())
    refused = sorted(served - set(INTENT_SCHEMA["properties"]))
    assert refused == ["mentioned_entities", "merchant_id"], refused
