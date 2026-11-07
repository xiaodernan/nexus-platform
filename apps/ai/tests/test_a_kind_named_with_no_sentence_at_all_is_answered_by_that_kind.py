"""D673 - a kind the caller named is honoured on the path that has no sentence, too.

`apps/ai/nexus_ai/contract.py:267` publishes the request's `filters.kind` as
`Optional[Literal["merchant", "product", "service", "experience"]]`, so an API caller can name a
product kind and nothing else: `{"filters": {"kind": "product"}, "limit": 6}` is a valid
`SearchRequest`. What it was answered with, measured on the shipped bytes before a line moved
(`tmp/d671_cards.py`, record `tmp/d671_cards.txt`), is six MERCHANTS - and the identical six
(香峰, 瀚館, 盛甬酒吧, 星灶, 瀚軒, 星里) for all three kinds, so the kind the caller named decided
nothing at all.

The mechanism was read out of the lane rather than inferred from the cards
(`tmp/d671_route.py`, record `tmp/d671_route.txt`): `plan_from_intent` is handed `intent=None` for a
request with no text, and

  * `SearchPlan.subject_types` is a field defaulting to `("merchant",)` (`search/service.py:715`);
  * the only reader of a caller-named kind for that field is the one at `search/service.py:952`,
  * and it sits BELOW the `if intent is None: ... return plan` exit at `:934-949`.

So a text-less kind ask leaves the function before the line that would honour its kind, and the
merchant statement runs - `search/sql.py:241` `build_merchant_query`, which has no kind predicate at
all (the only live one is inside `build_offering_query`, `search/sql.py:536`). A caller who asks for
products is served restaurants. The same filter WITH a text leg works (`髮` + `kind=service` answers
six services), because then an intent exists and :952 is reached - which is why the defect sat under
the census of asks that all carried a query.

What the fix is: the reader the intent path already has, on the path that never reaches it. Two
lines, the same test, the same value, inside the `intent is None` branch before its return. What it
is not: it is not a move of :952 above the early return, which would put the intent map's answer up
for grabs on a path that has no intent to consult, and it is not a widening - `kind: "merchant"` and
the absence of a kind keep answering merchants, which the legs below pin from both planes.

Two consequences the corpus settles rather than this file argues (`tmp/d672_measure.txt` re-serves
the same asks with the candidate rule applied in memory, and that is what this door now ships):

  * the offering lane answers a text-less kind ask completely: 6 of 6 for each kind at `limit 6`, 20
    of 20 at `limit 20`, and every served row is an `active` offering of a `published` merchant, so
    the status filter the merchant lane was passing is not lost by moving the subject;
  * the other filters still ride along: `{"kind": "product", "district": "中環"}` answers products,
    and a different six products than the unbounded ask.

The residue this door pins instead of fixing: both paths read the RAW filter, so a kind synonym
(`{"kind": "item"}`) is canonicalised into the filter by `_canonical_kind` and still never upgrades
the subject. The published `Literal` refuses that spelling at the API, so it is reachable only from
an internal caller - filed in `docs/PLAN.md` rather than answered here.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import os
import re
from typing import Any

import pytest
from fastapi.testclient import TestClient

import nexus_ai.search.service as S
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import Intent
from nexus_ai.db import pool as db_pool

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

KINDS = ("product", "service", "experience")

#: the asks the census served, and the six merchants each of the three kind-only ones received
TEXTLESS: list[tuple[str, dict[str, Any]]] = [
    ("kind=service", {"filters": {"kind": "service"}, "limit": 6}),
    ("kind=experience", {"filters": {"kind": "experience"}, "limit": 6}),
    ("kind=product", {"filters": {"kind": "product"}, "limit": 6}),
    ("kind=product, limit 20", {"filters": {"kind": "product"}, "limit": 20}),
    ("kind=merchant", {"filters": {"kind": "merchant"}, "limit": 6}),
    ("no kind, no text", {"limit": 6}),
    ("kind=product + district", {"filters": {"kind": "product", "district": "中環"}, "limit": 6}),
    ("kind=item (a synonym)", {"filters": {"kind": "item"}, "limit": 6}),
    ("髮 + kind=service (the text leg)", {"query": "髮", "filters": {"kind": "service"}, "limit": 6}),
]


#: The asks the live route can actually serve: the published `Literal` refuses `item` with a 422,
#: so that spelling is measured offline only (`test_a_synonym_kind_reaches_the_filter_but_not_the_
#: subject`, pinned in docs/PLAN.md) and never sent over HTTP. Everything else in TEXTLESS is.
SERVED: list[tuple[str, dict[str, Any]]] = [
    row for row in TEXTLESS
    if row[1].get("filters", {}).get("kind") in (None, "merchant", "product", "service", "experience")
]


def _settings(database_url: str = "") -> Settings:
    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=database_url, internal_token="")


def _run(query: str, *params) -> list[dict]:
    settings = _settings(DB_URL)

    async def _go():
        db = await db_pool.connect(settings, force_new=True)
        try:
            return [dict(r) for r in await db.fetch(query, *params)]
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _plan(filters: Any, *, intent: Intent | None = None, query: str | None = None):
    return S.plan_from_intent(intent, query=query, filters=filters, limit=6)


# ------------------------------------------------------------------ the plan, offline
def test_a_service_kind_named_with_no_sentence_selects_the_offering_lane():
    assert _plan({"kind": "service"}).subject_types == ("offering",)


def test_a_product_kind_named_with_no_sentence_selects_the_offering_lane():
    assert _plan({"kind": "product"}).subject_types == ("offering",)


def test_an_experience_kind_named_with_no_sentence_selects_the_offering_lane():
    assert _plan({"kind": "experience"}).subject_types == ("offering",)


def test_a_merchant_kind_named_with_no_sentence_keeps_the_merchant_lane():
    # the literal has four values and only three of them are offerings; honouring the kind the
    # caller named cannot mean answering offerings to a caller who asked for a merchant
    assert _plan({"kind": "merchant"}).subject_types == ("merchant",)


@pytest.mark.parametrize("filters", [None, {}, {"category": "cafe"}, {"kind": "ramen"}])
def test_an_ask_that_names_no_offering_kind_keeps_the_default_subject(filters):
    # `{"kind": "ramen"}` is not a kind the product has, and the lane must not invent one
    assert _plan(filters).subject_types == ("merchant",)


def test_a_named_kind_still_wins_over_an_intent_that_mapped_itself_to_merchants():
    # the intent path already answers this way (`service.py:952` overrides the map at `:951`); the
    # point of the leg is that both paths now give the same answer to the same filter
    intent = Intent.model_validate({"raw_query": "搵啲嘢", "intent": "discover_merchant"})
    plan = _plan({"kind": "product"}, intent=intent)
    assert S.KIND_TO_SUBJECT["discover_merchant"] == ("merchant",)
    assert plan.subject_types == ("offering",)


def test_the_upgrade_does_not_invent_a_sentence_the_caller_never_gave():
    # the fix is a subject choice, not a rewrite of the rest of the branch: a text-less plan still
    # has no query text, no match core, and keeps the filter it was handed
    plan = _plan({"kind": "service"})
    assert plan.query_text == ""
    assert plan.match_text == ""
    assert plan.filters.get("kind") == "service"


def test_a_synonym_kind_reaches_the_filter_and_the_subject():
    # D749: the residue filed in docs/PLAN.md is fixed — both paths now read the value
    # `_canonical_kind` canonicalises into, so `item` reaches `product` for the subject
    # read as well as the filter the serving path bakes into the query; the published
    # Filters model still refuses `item` at the API (see the live leg below), so the
    # canonicalisation is an internal-caller courtesy, not a widened contract.
    plan = _plan({"kind": "item"})
    assert plan.subject_types == ("offering",), plan.subject_types
    assert plan.filters.get("kind") == "product", plan.filters


def test_both_exits_from_this_function_have_a_reader_for_a_named_kind():
    # the defect was one path without a reader, so the shape is part of the promise: the kind test
    # appears on both sides of the `intent is None` return, not only below it
    src = inspect.getsource(S.plan_from_intent)
    exit_at = src.index("return plan")
    readers = [m.start() for m in re.finditer(r'in \("product", "service", "experience"\)', src)]
    assert len(readers) == 2, f"expected a reader on each path, found {len(readers)}"
    assert min(readers) < exit_at, "the early return still leaves before the kind is read"


# ------------------------------------------------------------------ the served answer
@functools.lru_cache(maxsize=1)
def _served() -> dict[str, list[dict]]:
    """Every ask above, once, through the shipped route in this process.

    The phases stay sequential: `db_pool.connect(force_new=True)` closes the pool the running app is
    using, so a ground-truth read interleaved with the asks would knock the service onto its demo
    fallback and the legs would then judge fixture rows they claim are live.
    """
    out: dict[str, list[dict]] = {}
    with TestClient(create_app(_settings(DB_URL))) as client:
        for label, body in SERVED:
            r = client.post("/ai/v1/search", json=body)
            assert r.status_code == 200, f"{label}: HTTP {r.status_code} {r.text[:200]}"
            j = r.json()
            assert not j.get("degraded"), (
                f"{label}: answered degraded ({j.get('degraded')}) - its cards come from the demo "
                "catalogue, where a kind ask has nothing to be wrong about")
            out[label] = j.get("items") or []
    return out


def _types(cards: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for card in cards:
        counts[str(card.get("card_type"))] = counts.get(str(card.get("card_type")), 0) + 1
    return counts


@live_only
@pytest.mark.parametrize("kind", ["service", "experience", "product"])
def test_a_kind_ask_with_no_sentence_answers_only_the_kind_it_named(kind):
    cards = _served()[f"kind={kind}"]
    assert cards, f"kind={kind}: the offering lane answered nothing at all"
    assert _types(cards) == {kind: len(cards)}, json.dumps(_types(cards), ensure_ascii=False)
    assert len(cards) == 6, f"kind={kind}: {len(cards)} cards for an ask that named limit 6"


@live_only
def test_the_three_kinds_are_three_different_answers():
    # a fix that simply switched the statement without reading WHICH kind was named would pass every
    # leg above and fail this one
    seen = {k: {str(c["id"]) for c in _served()[f"kind={k}"]} for k in KINDS}
    for k, ids in seen.items():
        assert len(ids) == 6, f"{k}: {len(ids)} distinct ids (a card repeated itself)"
    for a in KINDS:
        for b in KINDS:
            if a < b:
                assert not (seen[a] & seen[b]), f"{a} and {b} answered the same rows"


@live_only
def test_the_kind_answer_is_not_the_merchant_answer_relabelled():
    kinds = {str(c["id"]) for c in _served()["kind=product"]}
    merchants = {str(c["id"]) for c in _served()["no kind, no text"]}
    assert kinds and merchants
    assert not (kinds & merchants), "an offering id also served as a merchant: one list, two labels"


@live_only
def test_a_merchant_kind_ask_still_answers_merchants_live():
    cards = _served()["kind=merchant"]
    assert cards and _types(cards) == {"merchant": len(cards)}


@live_only
def test_an_ask_that_names_no_kind_still_answers_merchants_live():
    cards = _served()["no kind, no text"]
    assert cards and _types(cards) == {"merchant": len(cards)}


@live_only
def test_a_deeper_page_of_the_same_kind_ask_is_still_that_kind():
    cards = _served()["kind=product, limit 20"]
    assert len(cards) == 20, f"{len(cards)} cards for an ask that named limit 20"
    assert _types(cards) == {"product": 20}


@live_only
def test_the_district_that_rode_along_still_bounds_the_answer():
    bounded = _served()["kind=product + district"]
    plain = _served()["kind=product"]
    assert bounded, "the kind ask with a district answered nothing"
    assert _types(bounded) == {"product": len(bounded)}
    got = {str(c["id"]) for c in bounded}
    assert got != {str(c["id"]) for c in plain}, (
        "the district did not move the answer - the offering lane dropped the filter it was given")
    where = _run("""SELECT o.id::text AS id,
                           EXISTS (SELECT 1 FROM locations ld
                                   WHERE ld.merchant_id = o.merchant_id
                                     AND lower(coalesce(ld.district, '')) = 'central') AS in_central
                    FROM offerings o
                    WHERE o.id = ANY($1::uuid[])""", [str(c["id"]) for c in bounded])
    assert all(w["in_central"] for w in where), (
        f"an offering whose merchant has no Central location was served: "
        f"{[w['id'] for w in where if not w['in_central']][:3]}")


@live_only
def test_every_offering_the_fixed_lane_serves_is_an_active_row_of_a_published_merchant():
    # the merchant statement the ask used to reach carries its own status filter; moving the subject
    # must not move it, or a draft offering of an unpublished merchant starts reaching callers
    ids = [str(c["id"]) for k in KINDS for c in _served()[f"kind={k}"]]
    rows = _run("""SELECT o.id::text id, o.status ostatus, m.status mstatus
                  FROM offerings o JOIN merchants m ON m.id = o.merchant_id
                  WHERE o.id = ANY($1::uuid[])""", ids)
    assert len(rows) == len(ids), "a served offering id has no row of its own"
    bad = [r for r in rows if r["ostatus"] != "active" or r["mstatus"] != "published"]
    assert not bad, f"draft or unreachable rows reached a caller: {bad[:3]}"


@live_only
def test_the_text_leg_that_already_worked_still_works():
    cards = _served()["髮 + kind=service (the text leg)"]
    assert cards and _types(cards) == {"service": len(cards)}


@live_only
def test_the_published_literal_refuses_the_synonym_so_the_residue_reaches_no_caller():
    """The other half of the pinned residue, measured rather than asserted in prose.

    `test_a_synonym_kind_reaches_the_filter_but_not_the_subject` shows what the lane does with
    `{"kind": "item"}` when a caller hands it to `plan_from_intent` directly; this leg shows that the
    same request cannot arrive over the published route at all, which is why the residue is filed in
    `docs/PLAN.md` instead of answered here. A change that widens the `Literal` to accept synonyms
    turns this 422 into a 200 - and the offline leg then names which answer is wrong.
    """
    with TestClient(create_app(_settings(DB_URL))) as client:
        r = client.post("/ai/v1/search", json={"filters": {"kind": "item"}, "limit": 6})
    assert r.status_code == 422, f"HTTP {r.status_code}: {r.text[:200]}"
