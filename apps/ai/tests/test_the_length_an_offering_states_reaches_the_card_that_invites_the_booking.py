"""D674 - the length an offering states reaches the card that invites the booking.

`offerings.duration_minutes` is one of the four Booking columns (`docs/DATABASE.md:72` names
`bookable` / `min_party_size` / `max_party_size` / `duration_minutes` together) and the published card
declares the field: `packages/types/src/card.ts:150` comments it 「Duration in minutes — V1
`offerings.duration_minutes`」 and `:151`/`:164` put it on `ServiceCard` and `ExperienceCard`, while
`entity_card.json:98` publishes it at the base as `{"type": ["integer", "null"], "minimum": 0}`. The
closed object then refuses the KEY on the other three types (`:117` `merchant`, `:135` `product`,
`:196` `collection` each name it `false`) - so it is legal on exactly the two kinds the rows that state
a length belong to, to the row.

Nothing on the lane's side of that contract reached the field. `build_offering_query`'s projection put
the other three Booking columns into the offering row and dropped the fourth; `contract.EntityCard`
carried no such field and `model_config = ConfigDict(extra="ignore")`, so a value that did arrive would
be discarded; and `search/cards.py` built the card without it. Measured on the shipped bytes before
this unit (`tmp/d674_measure.py`, record `tmp/d674_measure.txt`): nine asks, **54 served cards, 36 of
them offerings, 0 carrying the key** - and the 28 distinct offerings behind those cards split **13
stating a length in the column, 0 of them printing it**, while **17 of the 36 print a 「訂枱」 CTA**.
That verb is what `build_actions` keys on `rec.get("bookable")` alone, and on this corpus the
invitation and the length come off one and the same set of rows: **804 offerings are `bookable` and
exactly those 804 state a `duration_minutes` > 0** (`dur_and_bookable 804` of `dur 804`; values
30/45/60/90/120/180 and nothing at 0), 682 of them reachable as `active` under a `published` merchant.
So the card asked the user to book and could not say what the booking takes.

Two things this unit does NOT do, both measured rather than assumed:

  * it invents nothing. A row that states no length prints `null`, which the published base property
    allows - the prose of a title is not a length, and neither is `nlu/timeparse.py`'s
    `_default_duration`, which returns 120 for a `morning` part whatever the offering says. That
    matters on this corpus: **221 reachable offerings state a length in their own name, and the column
    disagrees on 111 of them** (`tmp/d674_probe.txt` - 「全身按摩60分鐘」 carries 90, 「相機租借(按日)」
    carries 90, 「舊區導賞(3小時)」 carries 30 on one variant and nothing on another), while 95 name a
    length the column never states. The card now prints the column, which is the field the contract
    names as its source; the prose disagreement is seed data and is filed, not reconciled here.
  * it claims no slot. `availability.next_slot` stays null because `availability_slots` holds 32,492
    rows whose last end is 2026-10-13 against a `now()` of 2026-11-03 (`tmp/d674_probe.txt` section 2,
    `live 0`), so whether a merchant's window can HOLD an offering's length is unmeasurable today and
    no leg here asserts it.

And the key must be ABSENT, not null, on the three types that refuse it - which `Optional[int] = None`
cannot express in a `model_dump`, so `EntityCard` serializes its own shape (`DURATION_CARD_TYPES`)
rather than each dump site doing dict surgery. The rows below read the five `allOf` blocks back out of
the schema file, so widening the contract reddens the yardstick before it can redden a card.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from nexus_ai import contract as CONTRACT
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import EntityCard
from nexus_ai.db import pool as db_pool
from nexus_ai.search import sql as SQL
from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

CARD_SCHEMA = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                         .read_text(encoding="utf-8"))
PUBLISHED_KEYS = set(CARD_SCHEMA["properties"])
#: the card types whose `then` block names the key `false`, read off the contract rather than recited
FORBIDDEN_BY = {blk["if"]["properties"]["card_type"]["const"]
                for blk in CARD_SCHEMA["allOf"]
                if blk["then"]["properties"].get("duration_minutes") is False}
ALL_CARD_TYPES = set(CARD_SCHEMA["$defs"]["CardType"]["enum"])
ALLOWED_BY = ALL_CARD_TYPES - FORBIDDEN_BY

SUBJ = UUID("44444444-4444-4444-4444-444444444444")
SHOP = UUID("55555555-5555-5555-5555-555555555555")
TENANT = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"


def _offering_row(**over: Any) -> dict[str, Any]:
    """An offering row shaped the way `build_offering_query` returns one, after this unit."""
    row: dict[str, Any] = {
        "subject_type": "offering", "subject_id": str(SUBJ), "merchant_id_key": str(SHOP),
        "id": str(SUBJ), "slug": "gel-nails", "name": "Gel Nails", "name_zh": "凝膠美甲",
        "kind": "service", "merchant_slug": "lan-kwai-fong", "merchant_name": "Lan Kwai Fong",
        "category": "salon", "data_origin": "seed", "plan": "pro",
        "bookable": True, "min_party_size": 1, "max_party_size": 8, "duration_minutes": 90,
        "rating_agg": 4.5, "review_count": 10, "price_amount": 420.0, "currency": "HKD",
        "price_model": "fixed", "attributes": {}, "images": [],
    }
    row.update(over)
    return row


def _built(row: dict[str, Any], *, subject_type: str = "offering") -> EntityCard:
    cand = Candidate(subject_type=subject_type, subject_id=str(SUBJ), merchant_id=str(SHOP),
                     relevance=0.9, rating=4.5, rating_count=10, price=420.0)
    cand.raw = {"row": row, "text_matched": True, "as_of": "2026-11-03T12:00:00+08:00"}
    scored = Scored(candidate=cand, score=0.7, organic_score=0.7, breakdown={},
                    contributions=[("relevance", 0.3)])
    return build_card(cand, scored, FactBundle(), locale="zh-HK", query="美甲")


def _dumped(row: dict[str, Any], *, subject_type: str = "offering") -> dict[str, Any]:
    return _built(row, subject_type=subject_type).model_dump(mode="json")


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


def _served(body: dict[str, Any]) -> list[dict]:
    with TestClient(create_app(_settings(DB_URL))) as c:
        r = c.post("/ai/v1/search", json=body)
        assert r.status_code == 200, f"{body}: HTTP {r.status_code} {r.text[:200]}"
        payload = r.json()
    assert not payload.get("degraded"), f"{body}: served degraded, so the read below proves nothing"
    return payload.get("items") or []


SERVICE_ASK = {"filters": {"kind": "service"}, "limit": 6}
EXPERIENCE_ASK = {"filters": {"kind": "experience"}, "limit": 6}
PRODUCT_ASK = {"filters": {"kind": "product"}, "limit": 6}
MERCHANT_ASK = {"query": "cafe", "limit": 6}


# ------------------------------------------------------------------ the contract, read back
def test_the_published_object_leaves_the_key_on_two_types_and_refuses_it_on_three():
    """The yardstick: the shape this unit ships is decided by the schema file, not by this file."""
    assert FORBIDDEN_BY == {"merchant", "product", "collection"}, (
        f"entity_card.json now refuses the key on {sorted(FORBIDDEN_BY)}; the row below that pins "
        "the model's own allowed set has to be re-read against whatever the contract changed")
    assert ALLOWED_BY == {"service", "experience"}
    published = CARD_SCHEMA["properties"]["duration_minutes"]
    assert published == {"type": ["integer", "null"], "minimum": 0}, (
        f"the base property moved: {published} - a null and a number are two different claims, and "
        "this unit's card prints whatever the row states")
    assert CARD_SCHEMA["additionalProperties"] is False


def test_the_model_allows_exactly_the_types_the_published_object_leaves():
    # read off the module rather than imported by name: a tree that does not carry the constant yet
    # has to answer this leg RED, which is the honest reading of the bytes before the fix (arm `A`)
    types = getattr(CONTRACT, "DURATION_CARD_TYPES", None)
    assert types is not None, (
        "`nexus_ai.contract` names no `DURATION_CARD_TYPES`, so nothing on the model decides which "
        "card may carry the key")
    assert types == frozenset(ALLOWED_BY), (
        f"`EntityCard` serializes the key for {sorted(types)} while the closed object "
        f"leaves it on {sorted(ALLOWED_BY)} - the card would offend on one side or answer less than "
        "it may on the other")
    assert "duration_minutes" in EntityCard.model_fields, (
        "the model dropped the field again, and `extra=\"ignore\"` puts every card back to the shape "
        "this door was written against")


# ------------------------------------------------------------------ the read
def _select_and_where(builder, **kwargs) -> tuple[str, str]:
    text = builder(tenant_id=TENANT, **kwargs).sql
    head, _, tail = text.partition("\nWHERE ")
    return head, tail


def test_the_offering_read_selects_the_fourth_booking_column():
    head, where = _select_and_where(SQL.build_offering_query, text=None,
                                   filters={"kind": "service"}, limit=6)
    assert head.count("o.duration_minutes") == 1, (
        "the offering SELECT must carry the length exactly once - `build_offering_query` projected the "
        "other three Booking columns and dropped this one, which is how the number never reached a "
        "card")
    for sibling in ("o.bookable", "o.min_party_size", "o.max_party_size"):
        assert sibling in head, f"the row lost {sibling} while this unit was in it"
    assert "duration_minutes" not in where, (
        "the length is a claim the card prints, not a predicate: which rows answer a request is "
        "unchanged by this unit, and a WHERE here would silently shrink the pool")


def test_the_merchant_read_and_the_compare_read_still_name_neither():
    merchant_head, _ = _select_and_where(SQL.build_merchant_query, text=None, embedding=None,
                                         filters={}, limit=6)
    assert "duration" not in merchant_head, (
        "`merchants` has no such column - a merchant row carries no length of its own, and the "
        "card type that reads this projection refuses the key anyway")
    compare_sql, _params = SQL.entities_for(TENANT, [str(SUBJ)])
    assert "duration_minutes" not in compare_sql, (
        "filed residue, pinned so it stays a known gap rather than an accident: the /compare grid "
        "answers six attribute rows (price, rating, category, district, open_state, distance) and "
        "has no length row, so this read still needs nothing. If a duration column is added to the "
        "grid, this is the projection to edit")


# ------------------------------------------------------------------ the card
@pytest.mark.parametrize("kind", ["service", "experience"])
def test_a_card_of_a_type_the_contract_leaves_states_the_length_its_row_states(kind):
    card = _dumped(_offering_row(kind=kind, duration_minutes=120))
    assert card["card_type"] == kind
    assert "duration_minutes" in card, (
        f"a {kind} card dropped a key the published object leaves on its type - and the row states "
        "120, so there was something to say")
    assert card["duration_minutes"] == 120
    assert type(card["duration_minutes"]) is int, (
        "the property is published as an integer; a Decimal or a str is a different type on the wire")


@pytest.mark.parametrize("shape", ["absent", "null"])
def test_an_offering_that_states_no_length_prints_a_null_and_invents_nothing(shape):
    row = _offering_row()
    if shape == "absent":
        row.pop("duration_minutes")
    else:
        row["duration_minutes"] = None
    card = _dumped(row)
    assert "duration_minutes" in card and card["duration_minutes"] is None, (
        f"a row that states nothing ({shape}) must print nothing, not a guess: "
        f"{card.get('duration_minutes')!r} - DECISIONS D6 (never fabricate) and the published `null` "
        "arm are the two answers available")


def test_the_number_is_the_column_and_not_the_title():
    """The corpus argues with itself on 111 rows; the card follows the column it was told to follow."""
    name = "全身按摩60分鐘 Full Body Massage, 60 min"
    card = _dumped(_offering_row(name=name, name_zh=None, duration_minutes=180))
    assert card["title"] == name
    assert card["duration_minutes"] == 180, (
        "the title's prose says 60 and the column says 180; `card.ts:150` names the COLUMN as this "
        "field's source, so borrowing the number from the name would be the lane inventing a length "
        "while a measured disagreement goes unfixed in the seed")
    from nexus_ai.nlu.timeparse import _default_duration
    guesses = {_default_duration(p) for p in ("morning", "noon", "afternoon", "evening",
                                              "night", "late_night", None)}
    assert 180 not in guesses, (
        f"the part-of-day table now answers {guesses} and 180 is one of them, so this row can no "
        "longer tell the column's number from a guess (`timeparse.py` uses that default to set a "
        "window's end, never to state an offering's length) - re-aim the value, do not delete the leg")


#: `collection` is refused the key too, but `build_card` cannot make one (`kind` maps to
#: product/service/experience and everything else to product), so it gets its own row below
@pytest.mark.parametrize("card_type", sorted(FORBIDDEN_BY - {"collection"}))
def test_a_type_the_contract_refuses_the_key_on_drops_it_even_when_the_row_states_one(card_type):
    """Absent, not null: `false` under a `then` block means any value offends, including none."""
    if card_type == "merchant":
        row = _offering_row(subject_type="merchant", display_name="Lan Kwai Fong", kind=None)
        dumped = _dumped(row, subject_type="merchant")
    else:
        dumped = _dumped(_offering_row(kind=card_type, duration_minutes=90))
    assert dumped["card_type"] == card_type
    assert "duration_minutes" not in dumped, (
        f"a {card_type} card sent the key entity_card.json names `false` for it - `Optional[int] = "
        "None` cannot express an absent field, which is why the model serializes this rule")
    assert dumped["id"] is not None


def test_a_collection_card_drops_it_too_though_no_lane_builds_one_today():
    """The third refusing type has no producer in the AI lane; the rule must still hold for it."""
    card = EntityCard(card_type="collection", id=str(SUBJ), slug="s", title="t",
                      duration_minutes=90)
    assert "duration_minutes" not in card.model_dump(mode="json")
    assert "duration_minutes" not in json.loads(card.model_dump_json())


def test_the_two_serializers_agree_about_absence():
    """`api/pipeline.py:214` dumps dicts; `api/stream.py:116` serializes the model to JSON."""
    for row, expected in ((_offering_row(kind="service"), True),
                          (_offering_row(kind="product", duration_minutes=90), False)):
        card = _built(row)
        dumped = card.model_dump(mode="json")
        parsed = json.loads(card.model_dump_json())
        assert ("duration_minutes" in dumped) is expected
        assert ("duration_minutes" in parsed) is expected, (
            "the same card answering differently per wire is how a contract offence hides")
        assert dumped == parsed or set(dumped) == set(parsed)


def test_the_length_and_the_verb_come_off_the_same_row_and_neither_keys_the_other():
    """The user consequence: 「訂枱」 invites a booking; the number says what it takes."""
    booked = _dumped(_offering_row(bookable=True, duration_minutes=120))
    verbs = [a["type"] for a in booked["actions"]]
    assert "reserve" in verbs and booked["duration_minutes"] == 120
    unbooked_but_long = _dumped(_offering_row(bookable=False, duration_minutes=45))
    assert "reserve" not in [a["type"] for a in unbooked_but_long["actions"]], (
        "this unit changed no verb: `build_actions` keys `reserve` on `bookable` alone, and that is "
        "the shape PLAN files separately")
    assert unbooked_but_long["duration_minutes"] == 45, (
        "a length is not a booking claim; suppressing it because the shop cannot be booked would "
        "hide what the row states")
    bare = _dumped(_offering_row(bookable=False, duration_minutes=None))
    assert bare["duration_minutes"] is None


def test_the_closed_object_still_closes_and_says_the_length_once():
    """Nothing else joined the payload, and the number is not also parked in `facts[]`."""
    for row in (_offering_row(), _offering_row(kind="product", duration_minutes=None),
                _offering_row(subject_type="merchant", display_name="Lan Kwai Fong", kind=None)):
        subject_type = "merchant" if row.get("display_name") else "offering"
        card = _dumped(row, subject_type=subject_type)
        extra = sorted(set(card) - PUBLISHED_KEYS)
        assert not extra, f"the card sends {extra}, which the closed object of 43 properties refuses"
        cited = [f for f in (card.get("facts") or [])
                 if "duration" in str(f.get("attribute"))
                 or "duration" in json.dumps(f.get("value") or {}, default=str)]
        assert not cited, (
            f"the length is now stated twice ({cited}); DECISIONS D28 keeps one copy, and the "
            "published top-level property is the copy the contract declares")


# ------------------------------------------------------------------ the served page
@live_only
def test_a_service_ask_states_the_length_of_the_offerings_it_answers():
    cards = _served(SERVICE_ASK)
    assert len(cards) == 6 and {c["card_type"] for c in cards} == {"service"}, (
        f"the kind-only ask answers {sorted({c['card_type'] for c in cards})} - D673 landed that "
        "routing, so this row is about a page of service offerings and needs one")
    missing = [c["title"] for c in cards if "duration_minutes" not in c]
    assert not missing, f"service cards without the key the type publishes: {missing}"


@live_only
def test_an_experience_ask_states_the_length_of_the_offerings_it_answers():
    cards = _served(EXPERIENCE_ASK)
    assert {c["card_type"] for c in cards} == {"experience"}
    assert all("duration_minutes" in c for c in cards)


@live_only
def test_a_product_ask_sends_no_key_and_loses_nothing_by_it():
    cards = _served(PRODUCT_ASK)
    assert {c["card_type"] for c in cards} == {"product"}
    sent = [c for c in cards if "duration_minutes" in c]
    assert not sent, f"product cards carrying the key the contract refuses: {len(sent)}"
    ids = [str(c["id"]) for c in cards]
    rows = _run("""SELECT id::text id, kind, duration_minutes FROM offerings
                   WHERE id = ANY($1::uuid[])""", ids)
    stating = [r for r in rows if r["duration_minutes"]]
    assert not stating, (
        f"these {len(stating)} product rows state a length and their cards refuse to print it - the "
        "closed object forbids the key on `product`, so the corpus staying duration-free for that "
        "kind is what makes absence honest, and §668 measured 0 of 4,184")


@live_only
def test_a_merchant_ask_sends_no_key():
    cards = _served(MERCHANT_ASK)
    assert {c["card_type"] for c in cards} == {"merchant"}
    sent = [c for c in cards if "duration_minutes" in c]
    assert not sent, f"merchant cards carrying the key `entity_card.json:117` refuses: {len(sent)}"


@live_only
def test_the_number_every_offering_card_prints_is_the_databases_own():
    cards = _served(SERVICE_ASK) + _served(EXPERIENCE_ASK)
    ids = sorted({str(c["id"]) for c in cards})
    rows = {r["id"]: r for r in _run(
        """SELECT o.id::text id, o.kind, o.duration_minutes, o.bookable FROM offerings o
           WHERE o.id = ANY($1::uuid[])""", ids)}
    wrong = [(c["id"], c.get("duration_minutes"), rows[str(c["id"])]["duration_minutes"])
             for c in cards if c.get("duration_minutes") != rows[str(c["id"])]["duration_minutes"]]
    assert not wrong, f"cards printing a length their own row does not state: {wrong}"
    assert len(rows) == len(ids), f"{len(ids)} cards, {len(rows)} rows read back"
    stated = [c for c in cards if c.get("duration_minutes")]
    assert len(stated) >= 6, (
        f"only {len(stated)} of {len(cards)} served cards state a length; 682 of the 4,707 offerings "
        "the lane can answer do, so a page of six services should carry several - if the seed changed "
        "this bound moves with it, and the answer is to re-measure, not to delete the leg")


@live_only
def test_every_served_card_that_invites_a_booking_states_one():
    """The corpus invariant the whole unit rests on: `bookable` and a stated length are one set."""
    cards = _served(SERVICE_ASK) + _served(EXPERIENCE_ASK) + _served(PRODUCT_ASK)
    booking = [c for c in cards if any(a["type"] == "reserve" for a in (c.get("actions") or []))]
    assert booking, "no served card invited a booking, so this row would pass on an empty page"
    blind = [c["title"] for c in booking
             if not isinstance(c.get("duration_minutes"), int) or c["duration_minutes"] <= 0]
    assert not blind, (
        f"{len(blind)} card(s) print 「訂枱」 and no length: {blind}. Before this unit that was 17 of "
        "17 (`tmp/d674_measure.txt`); on this corpus every `bookable` offering states a "
        "duration_minutes > 0 (`tmp/d674_probe.txt`), so a booking invitation without a number is "
        "either a lost projection or a seed row that broke the invariant")
