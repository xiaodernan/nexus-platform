"""§18/§19 — the recommendation grounding boundary.

A recommendation bullet the user sees must trace to a `fact_id` (a verifiable fact),
or be a deliberately *labelled* commercial signal (`sponsored`). This module proves
`drop_ungrounded_reasons` enforces that at the wire, and that the live `/ai/v1/recommend`
response never carries an ungrounded non-sponsored reason.
"""

from __future__ import annotations

from uuid import uuid4

from nexus_ai.contract import AiMatch, EntityCard, MatchExplanation
from nexus_ai.search.cards import drop_ungrounded_reasons


def _card(*reasons: MatchExplanation) -> EntityCard:
    return EntityCard(
        card_type="merchant", id=uuid4(), slug="s", title="T",
        ai_match=AiMatch(score=0.5, reasons=list(reasons)))


def _reason(label: str, *, fact_id=None) -> MatchExplanation:
    return MatchExplanation(label=label, text=f"t:{label}", value=None, fact_id=fact_id)


def test_drops_ungrounded_non_sponsored_reason():
    fid = uuid4()
    card = _card(_reason("top_rated", fact_id=fid), _reason("trending"))  # trending has no fact
    out, dropped = drop_ungrounded_reasons(card)
    assert dropped == 1
    labels = [r.label for r in out.ai_match.reasons]
    assert labels == ["top_rated"]


def test_keeps_sponsored_without_fact_id():
    # §1846: a paid placement is *labelled*, never faked into a trust reason.
    card = _card(_reason("sponsored"))  # sponsored is allowed no fact_id
    out, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0
    assert [r.label for r in out.ai_match.reasons] == ["sponsored"]


def test_keeps_fully_grounded_card():
    card = _card(_reason("top_rated", fact_id=uuid4()),
                 _reason("near_you", fact_id=uuid4()))
    out, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0
    assert len(out.ai_match.reasons) == 2


def test_noop_when_no_ai_match():
    card = EntityCard(card_type="merchant", id=uuid4(), slug="s", title="T")
    out, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0
    assert out.ai_match is None


def test_recommend_response_carries_only_grounded_non_sponsored_reasons(client):
    r = client.post("/ai/v1/recommend", json={"query": "quiet dinner sha tin", "limit": 5})
    assert r.status_code == 200
    for item in r.json()["items"]:
        for reason in (item.get("ai_match") or {}).get("reasons", []):
            if reason["label"] == "sponsored":
                continue  # the one deliberate exception
            assert reason["fact_id"], (
                f"ungrounded non-sponsored reason {reason['label']!r} reached the user")
