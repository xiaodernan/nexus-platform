"""D497 - a fact conflict is SURFACED, not silently picked.

AGENT_CONTRACT §4 (non-negotiable): *Conflicts create a `trust_signals` row rather than
silently picking.* The product picked silently - the card showed one value and the other
one vanished - and the trust layer's own resolver, which does exactly what §4 says, was
called by nothing.

The row itself is the platform's to write: the AI service's database role has **no** grant
on `trust_signals` (measured against the live database - the role cannot even read the
table), and the contract's §0 grant set does not name it either. That half is filed. The
half the AI lane owns is the card: it must not hide that a value is disputed.

This gate holds the card to it:
  * two facts of one attribute with different values make the card say so ✓ - the flag the
    contract's §2 should name (filed) ✓;
  * a card whose facts agree carries no such flag ✓ - the flag must mean something ✓;
  * and the rule that decides which value wins is the trust layer's own resolver ✓ (one
    fact, one place ✓) ✓.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate
from nexus_ai.trust.facts import Fact, FactBundle, resolve_conflicts

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
MERCHANT = uuid.UUID(int=11)


def _fact(attribute: str, value: object, source: str, confidence: float) -> Fact:
    return Fact(
        fact_id=uuid.uuid5(uuid.NAMESPACE_URL, f"fact:{attribute}:{value}:{source}"),
        subject_type="merchant",
        subject_id=MERCHANT,
        attribute=attribute,
        value=value,
        source=source,
        confidence=confidence,
        observed_at=NOW,
    )


def _card(bundle: FactBundle):
    cand = Candidate(
        subject_type="merchant", subject_id=str(MERCHANT), merchant_id=str(MERCHANT),
        price=128.0, rating=4.6, rating_count=200,
        raw={"row": {"name": "Test Kitchen", "slug": "test-kitchen",
                     "category": "restaurant"}},
    )
    return build_card(cand, None, bundle, locale="zh-HK")


def test_a_disputed_price_is_flagged():
    """The measured case: two prices, one card, and the card must say so."""
    bundle = FactBundle(facts=[
        _fact("price", {"amount": "128.00", "currency": "HKD"}, "merchant", 0.95),
        _fact("price", {"amount": "99.00", "currency": "HKD"}, "observed", 0.8),
    ])
    card = _card(bundle)
    assert card.flags.conflicting_fact, (
        "the card shows a price that two facts disagree about and does not say so - §4: a "
        "conflict is not resolved silently")
    assert card.price is not None, "the card shows no price at all"


def test_a_disputed_rating_is_flagged():
    bundle = FactBundle(facts=[
        _fact("rating", {"value": 4.6, "count": 200}, "merchant", 0.9),
        _fact("rating", {"value": 3.1, "count": 2}, "observed", 0.7),
    ])
    card = _card(bundle)
    assert card.flags.conflicting_fact, (
        "the card shows a rating that two facts disagree about and does not say so")


def test_agreeing_facts_are_not_flagged():
    """A card whose facts agree carries no flag - the flag must mean something."""
    bundle = FactBundle(facts=[
        _fact("price", {"amount": "128.00", "currency": "HKD"}, "merchant", 0.95),
        _fact("price", {"amount": "128.00", "currency": "HKD"}, "observed", 0.8),
    ])
    card = _card(bundle)
    assert not card.flags.conflicting_fact, (
        "the card is flagged as disputed although its facts agree")


def test_the_trust_layer_resolver_is_the_one_that_decides():
    """One rule: the trust layer's resolver says which value won, and the card uses it."""
    bundle = FactBundle(facts=[
        _fact("price", {"amount": "128.00", "currency": "HKD"}, "merchant", 0.95),
        _fact("price", {"amount": "99.00", "currency": "HKD"}, "observed", 0.8),
    ])
    chosen, disagreements = resolve_conflicts(bundle, "price", MERCHANT)
    assert chosen is not None and chosen.value["amount"] == "128.00"
    assert disagreements and disagreements[0]["kind"] == "price_anomaly"
    assert disagreements[0]["evidence"]["resolution"] == "source_hierarchy"
    assert disagreements[0]["evidence"]["conflicting"]["value"]["amount"] == "99.00"
