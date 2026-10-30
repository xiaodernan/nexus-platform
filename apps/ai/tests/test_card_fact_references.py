"""D428 - the card's fact references: the contract's `source_fact_id` was always null.

`OpenState` and `AvailabilityBrief` both declare a `source_fact_id` — the trust primitive
(§4/§19: any AI-stated fact cites one of these) — and the card's construction FILTERED the
keys it passed, so the field was always null while the card carried the very fact it names
in its own `facts` list. The availability brief's field came from a dict that does not carry
one, so it was null as well.

These cases pin the reference: the card's open state and its availability brief point at the
facts the card already carries, so a reader can trace every rendered number back to its
source.

D619 corrected the NAME this file used for the availability brief's pointer. The two objects do
not share one: `EntityCard.open` points at `CardOpeningState`, which carries `source_fact_id`,
while `EntityCard.availability` points at `fact.json#/$defs/AvailabilityInfo`, whose properties
do not include it and which names the same pointer `fact_id`. The brief's field was therefore a
key the published block refuses, on every card the lane sent - see
`tmp/d619_avail_census.py` and `tmp/d619_validate.mjs`. The claim of these cases did not change.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
NOW = datetime(2024, 1, 1, 12, 0, tzinfo=HK_TZ)   # Monday 12:00 HKT


def _candidate() -> Candidate:
    return Candidate(subject_type="merchant", subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=4.5, rating_count=10, price=120.0)


def _card(open_state: dict | None, availability: dict | None):
    bundle = FactBundle()
    cand = _candidate()
    cand.raw = {"row": {"slug": "s-1", "display_name": "A Bistro", "category_primary": "restaurant"},
                "text_matched": True, "as_of": NOW}
    return build_card(cand, Scored(candidate=cand, score=0.9, organic_score=0.9, breakdown={}),
                      bundle, locale="zh-HK", open_state=open_state, availability=availability,
                      query="bistro")


def test_the_open_state_names_the_fact_it_came_from():
    card = _card({"is_open": True, "text": "Open until 18:00", "as_of": NOW.isoformat()}, None)
    assert card.open is not None
    assert card.open.source_fact_id is not None, (
        "the open state does not name the fact it came from")
    facts = {f.attribute: f for f in (card.facts or [])}
    assert facts.get("open_state") is not None
    assert str(card.open.source_fact_id) == str(facts["open_state"].fact_id)


def test_the_availability_brief_names_its_fact():
    card = _card({"is_open": True, "text": "Open", "as_of": NOW.isoformat()},
                 {"status": "available", "next_slot": NOW.isoformat()})
    assert card.availability is not None
    assert card.availability.fact_id is not None, (
        "the availability brief does not name the fact it came from")
    facts = {f.attribute: f for f in (card.facts or [])}
    assert facts.get("availability") is not None
    assert str(card.availability.fact_id) == str(facts["availability"].fact_id)
    assert "source_fact_id" not in card.availability.model_dump(), (
        "the brief carries a key AvailabilityInfo does not have")


def test_a_card_with_no_open_state_still_builds():
    card = _card(None, None)
    assert card.open is not None
    assert card.open.is_open is None
    assert card.open.source_fact_id is None
