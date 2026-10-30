"""D619 - the availability object the card sends is the one the published schema accepts.

`EntityCard.availability` is not a free dict. It is `oneOf` of null and
`fact.json#/$defs/AvailabilityInfo` (`packages/types/src/schemas/entity_card.json`), a block that
requires `status` and `next_slot` to be PRESENT, gives `status` four words
(`available | limited | unavailable | unknown`), and sets `additionalProperties: false`. The AI lane
sent three things that block refuses, on every card of both planes measured by
`tmp/d619_dump_cards.py` (41 cards: 5 demo, 36 live):

  * the key `source_fact_id`, which belongs to the OPEN block, not this one - the block names the
    same pointer `fact_id` (`tmp/d619_avail_census.py`);
  * no `status` at all when the slot read came back empty: `build_card` filtered `is not None`
    values out of the brief, so a card that asked for a slot and got none dropped the required key
    and sent `{"status": null, "next_slot": null, "source_fact_id": null}`;
  * the ranking lane's own word `full` (the ternary in `candidates_from_rows`, pinned by
    test_candidates_from_rows.py:103), which is not one of the four.

The block's own cross-object rule then adds a fourth (`packages/types/scripts/rules.mjs`,
`entity_card_rendered_value_backed`): `available` or `limited` without `next_slot` is "a bookable
claim [that] needs a slot (DECISIONS D6: never fabricate one)", and a non-`unknown` status without
`as_of` breaks AGENT_CONTRACT §5, which sets availability's TTL to 0. `tmp/d619_dump_shapes.py` built
those shapes because neither plane has a slot row today (`tmp/d619_slot_window.txt`), and
`tmp/d619_validate.mjs` judged them with the contract package's own validator. At the commit this
door was written into (`tmp/d619_arms.py`, arm A): 41 of 41 served cards offend, and all 4 shapes
offend with 2 issues each. With these two files as they now stand (arm D): 0 of 41, 0 of 4, and the
9 rows below pass; each of the four single-line mutations there (E-H) turns exactly one row red.

The yardstick here is `packages/types/src/schemas`, the tracked half: `git ls-files
packages/types/dist` answers 0 files, so `dist` is a build product and cannot be what a door reads.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import AvailabilityBrief
from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

BLOCK = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "fact.json")
                   .read_text(encoding="utf-8"))
CARD = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                  .read_text(encoding="utf-8"))
AVAIL = BLOCK["$defs"]["AvailabilityInfo"]
#: the two keys the block requires to be present, not the two it allows to be missing
REQUIRED = AVAIL["required"]
PROPS = set(AVAIL["properties"])
STATUS_WORDS = set(BLOCK["$defs"]["AvailabilityStatus"]["enum"])

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
NOW = datetime(2026, 10, 30, 12, 0, tzinfo=HK_TZ)
SLOT = NOW.isoformat()


def _dumped(availability: dict | None) -> dict:
    """The card a candidate with this availability read turns into, as the wire sends it.

    `candidates_from_rows` puts the lane's dict in `raw["availability"]` and the row clock in
    `raw["as_of"]`, in the same dict, so both are set the way the shipped producer sets them.
    """
    cand = Candidate(subject_type="merchant", subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=4.5, rating_count=10, price=120.0,
                     availability=(availability or {}).get("status"))
    cand.raw = {"row": {"slug": "s-1", "display_name": "A Bistro",
                        "category_primary": "restaurant"},
                "text_matched": True, "as_of": NOW, "availability": availability}
    card = build_card(cand, Scored(candidate=cand, score=0.9, organic_score=0.9, breakdown={}),
                      FactBundle(), locale="zh-HK", open_state=None, availability=availability,
                      query="bistro")
    return card.model_dump(mode="json")


def _brief(availability: dict | None) -> dict:
    return _dumped(availability)["availability"]


def _assert_accepted(name: str, brief: dict | None) -> None:
    if brief is None:
        return  # the other branch of the card's `oneOf`
    extra = sorted(set(brief) - PROPS)
    assert not extra, (f"the card's {name} carries {extra}, and AvailabilityInfo sets "
                       f"additionalProperties=false")
    missing = sorted(set(REQUIRED) - set(brief))
    assert not missing, f"the card's {name} omits the required keys {missing}"
    assert brief["status"] in STATUS_WORDS, (
        f"the card's {name} sends status={brief['status']!r}, which is not one of "
        f"{sorted(STATUS_WORDS)}")


def _cards_from(database_url: str) -> list[dict]:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=database_url, internal_token="")
    with TestClient(create_app(settings)) as client:
        r = client.post("/ai/v1/search", json={"query": "browse restaurant", "limit": 6})
        assert r.status_code == 200, r.text
        return r.json()["items"]


def test_the_published_block_still_is_the_yardstick_this_gate_reads():
    # a door that reads a schema must notice when the schema moves under it
    assert AVAIL["additionalProperties"] is False
    assert set(REQUIRED) == {"status", "next_slot"}
    assert STATUS_WORDS == {"available", "limited", "unavailable", "unknown"}
    refs = [branch.get("$ref", "") for branch in CARD["properties"]["availability"]["oneOf"]]
    assert any(ref.endswith("fact.json#/$defs/AvailabilityInfo") for ref in refs), refs


def test_the_brief_declares_no_key_the_published_block_refuses():
    fields = set(AvailabilityBrief.model_fields)
    extra = sorted(fields - PROPS)
    assert not extra, (f"`AvailabilityBrief` declares {extra}, keys the block this field points "
                       f"at does not have - the wire would send them")
    assert "source_fact_id" not in fields, (
        "the availability brief carries the OPEN block's pointer name; AvailabilityInfo "
        "calls it fact_id")
    missing = sorted(set(REQUIRED) - fields)
    assert not missing, f"the brief cannot carry the required keys {missing}"


def test_a_card_that_read_no_slot_sends_the_fourth_word_and_both_required_keys():
    brief = _brief(None)
    _assert_accepted("availability", brief)
    assert brief["status"] == "unknown", (
        "a card that read no slot may not name one: `unknown` is the block's own answer")
    assert "next_slot" in brief, (
        "the required key was dropped rather than sent null")


def test_the_lane_word_for_no_seats_left_becomes_the_contract_word():
    brief = _brief({"status": "full", "next_slot": SLOT})
    _assert_accepted("availability", brief)
    assert brief["status"] == "unavailable", (
        f"the card sent the ranking lane's `full`, which is not one of {sorted(STATUS_WORDS)}")


def test_a_bookable_word_with_no_instant_is_not_sent_as_a_bookable_claim():
    # rules.mjs `entity_card_rendered_value_backed`: a bookable claim needs a slot
    brief = _brief({"status": "limited", "next_slot": None})
    _assert_accepted("availability", brief)
    assert brief["status"] == "unknown", (
        "the card promised a bookable status with no moment behind it")


def test_the_brief_cites_the_fact_the_card_already_carries():
    dumped = _dumped({"status": "available", "next_slot": SLOT})
    brief = dumped["availability"]
    _assert_accepted("availability", brief)
    facts = {f["attribute"]: f for f in (dumped.get("facts") or [])}
    assert "availability" in facts, "the card carries no availability fact to cite"
    assert str(brief["fact_id"]) == str(facts["availability"]["fact_id"]), (
        "the brief does not name the fact the card already prints")
    assert "source_fact_id" not in brief, (
        "the block forbids a key it does not name")


def test_the_brief_stamps_the_clock_the_row_was_read_at():
    # AGENT_CONTRACT §5: availability's TTL is 0, so the stamp is what tells a reader
    # whether "available" was read now or in a previous request
    brief = _brief({"status": "available", "next_slot": SLOT})
    assert brief["status"] != "unknown"
    assert brief["as_of"] is not None, (
        "a non-unknown status with no as_of reads as live when the lane never said when")
    assert brief["as_of"] == SLOT, "the stamp is not the row clock the candidate carried"


def test_every_card_the_demo_plane_serves_is_accepted_by_the_block():
    cards = _cards_from("")
    assert cards, "the plane served no card, so this row measured nothing"
    for card in cards:
        _assert_accepted(f"{card['slug']}'s availability", card.get("availability"))


@live_only
def test_every_card_the_live_plane_serves_is_accepted_by_the_block():
    cards = _cards_from(DB_URL)
    assert cards, "the live plane served no card, so this row measured nothing"
    for card in cards:
        _assert_accepted(f"{card['slug']}'s availability", card.get("availability"))
