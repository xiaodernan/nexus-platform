"""§4 / AGENT_CONTRACT §4 (spec §72) — the hallucination gate.

`nexus_ai.trust.verification` is the post-hoc claim checker: every numeric/entity claim
in generated copy is matched back to retrieved facts; unmatched claims are stripped and
counted in `hallucination_rate`. This is the product's most important quality gate, and it
had **no tests**. This pins its contract — including the tight tolerances the docstring
calls out (a fabricated HK$500 against a grounded 320 is caught; 700m grounds to a
computed 683m). All pure logic — no DB, no provider.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from nexus_ai.contract import Fact
from nexus_ai.trust.facts import FactBundle
from nexus_ai.trust.verification import (
    COUNT_KIND, DISTANCE_KIND, MONEY_KIND, RATING_KIND, TIME_KIND, extract_claims,
    verify_generated_text)


def _fact(*, attribute: str, value, fact_id=None, source: str = "merchant") -> Fact:
    return Fact(
        fact_id=fact_id or uuid4(), subject_type="merchant", subject_id=uuid4(),
        attribute=attribute, value=value, source=source, confidence=0.9,
        observed_at=datetime(2026, 1, 1, tzinfo=timezone.utc))


def test_extract_claims_reads_kinds_and_values():
    text = "HK$320 評分 4.7 700m 20% 5 間餐廳 18:30"
    claims = extract_claims(text)
    by_kind = {c.kind: c for c in claims}
    assert by_kind[MONEY_KIND].value == 320.0
    assert by_kind[RATING_KIND].value == 4.7
    assert by_kind[DISTANCE_KIND].value == 700.0
    assert by_kind["percent"].value == 20.0
    assert by_kind[COUNT_KIND].value == 5.0
    assert by_kind[TIME_KIND].value == 18 * 60 + 30


def test_extract_claims_empty_text_is_empty():
    assert extract_claims("") == []


def test_grounded_claims_pass_the_gate():
    bundle = FactBundle([_fact(attribute="price", value=320.0),
                         _fact(attribute="rating", value=4.65)])
    report = verify_generated_text("HK$320 評分 4.7", bundle=bundle)
    assert report.ok is True
    assert report.hallucination_count == 0
    assert report.hallucination_rate == 0.0


def test_fabricated_price_is_caught_and_stripped():
    # the docstring's canonical example: HK$500 against a grounded 320 must not pass
    bundle = FactBundle([_fact(attribute="price", value=320.0)])
    report = verify_generated_text("HK$500", bundle=bundle)
    assert report.ok is False
    assert report.hallucination_count == 1
    assert len(report.stripped) == 1
    assert report.text == ""  # the ungrounded claim never reaches a screen


def test_distance_tolerance_accepts_near_value_and_rejects_far():
    near = FactBundle([_fact(attribute="distance_m", value=683.0)])
    far = FactBundle([_fact(attribute="distance_m", value=100.0)])
    assert verify_generated_text("700m", bundle=near).ok is True
    assert verify_generated_text("700m", bundle=far).ok is False


def test_the_renderer_contract_drops_a_bullet_without_provenance():
    # D503: the trust layer held a SECOND copy of the §4 renderer rule, and it was the
    # copy the contract FORBIDS: it kept a bullet with no `fact_id` when the bullet's
    # claims happened to ground. The product's guard - `drop_ungrounded_reasons` - drops it
    # (the `sponsored` label excepted: a paid placement is LABELLED as such rather than
    # faked into a trust reason, §1846). This test now asserts the PRODUCT's rule.
    from nexus_ai.contract import AiMatch, EntityCard, MatchExplanation
    from nexus_ai.search.cards import drop_ungrounded_reasons

    def _card(reason: MatchExplanation) -> EntityCard:
        return EntityCard(
            card_type="merchant", id=uuid4(), slug="x", title="x",
            ai_match=AiMatch(score=1.0, reasons=[reason]))

    grounded = _card(MatchExplanation(label="matches_query", text="HK$320", value="320",
                                      fact_id=None))
    kept, dropped = drop_ungrounded_reasons(grounded)
    assert dropped == 1, (
        "a bullet with no fact_id was kept - §4: if `fact_id` is missing, the UI must not "
        "render that bullet")
    assert kept.ai_match.reasons == []

    sponsored = _card(MatchExplanation(label="sponsored", text="sponsored", value=None,
                                       fact_id=None))
    kept, dropped = drop_ungrounded_reasons(sponsored)
    assert dropped == 0, "the sponsored label is the one exception - a paid placement is "\
                         "LABELLED, not hidden"
    assert len(kept.ai_match.reasons) == 1


def test_a_fabricated_claim_in_an_unprovenanced_bullet_is_dropped():
    from nexus_ai.contract import AiMatch, EntityCard, MatchExplanation
    from nexus_ai.search.cards import drop_ungrounded_reasons

    card = EntityCard(
        card_type="merchant", id=uuid4(), slug="x", title="x",
        ai_match=AiMatch(score=1.0, reasons=[
            MatchExplanation(label="matches_query", text="HK$999", value="999",
                             fact_id=None)]))
    kept, dropped = drop_ungrounded_reasons(card)
    assert dropped == 1
    assert kept.ai_match.reasons == []
