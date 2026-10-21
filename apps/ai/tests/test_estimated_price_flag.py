"""D472 - the `estimated_price` flag: the contract names it, so the card must carry it.

API_CONTRACT §2 names the flag: "two projections add one flag of their own:
`estimated_price` on offering cards (`offerings.price_source = 'estimated'`)" - and the
offering's query already selects `price_source`. The card's `EntityFlags` could not carry the
flag at all, so a renderer told to look for it was looking for a field that was never sent.

This gate checks the two halves: the contract's §2 names the flag, and the card builder
maps the offering's `price_source` onto it.
"""

from __future__ import annotations

from pathlib import Path

from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "docs" / "API_CONTRACT.md"

OFFERING = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
MERCHANT = "3f2504e0-4f89-11d3-9a0c-0305e82c3302"


def _contract_names_the_flag() -> bool:
    text = CONTRACT.read_text(encoding="utf-8")
    start = text.find("## 2. Core shared objects")
    end = text.find("\n## 3.", start)
    section = text[start:end] if end > start else text[start:start + 4000]
    return "estimated_price" in section


def _card_with_price_source(source: str):
    candidate = Candidate(
        subject_type="offering",
        subject_id=OFFERING,
        merchant_id=MERCHANT,
        raw={"row": {
            "id": OFFERING,
            "slug": "house-ramen",
            "name": "House Ramen",
            "name_zh": "House Ramen",
            "price_amount": "88.00",
            "currency": "HKD",
            "price_model": "fixed",
            "price_source": source,
            "data_origin": "seed",
            "ownership_verified": True,
        }},
    )
    return build_card(candidate, None, FactBundle())


def test_the_contract_names_the_flag():
    assert _contract_names_the_flag(), (
        "API_CONTRACT §2 no longer names `estimated_price` - the flag's name comes from the "
        "contract, and a gate that cannot read the contract proves nothing")


def test_an_estimated_price_carries_the_flag():
    card = _card_with_price_source("estimated")
    assert card.flags.estimated_price is True, (
        "the offering's price came from an estimate and the card does not say so - the "
        "contract's §2 flag is set from `offerings.price_source`")


def test_a_merchant_price_does_not_carry_the_flag():
    card = _card_with_price_source("merchant")
    assert card.flags.estimated_price is False, (
        "the merchant set the price and the card claims it was estimated")


def test_the_flag_is_on_every_card():
    card = _card_with_price_source("observed")
    assert card.flags.estimated_price is False
    assert "estimated_price" in card.flags.model_dump(mode="json"), (
        "the flag is missing from the card's flags entirely - a renderer cannot look for a "
        "field that is not there")
