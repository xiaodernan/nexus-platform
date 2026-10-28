"""`search/cards.py` — EntityCard assembly, open-state and §18 reason grounding.

`drop_ungrounded_reasons` was pinned in D339; this unit covers the rest of the (pure,
DB-free) card layer:

- `compute_open` derives open/closed state from `business_hours` and **never guesses** when
  the merchant has no hours (§2) — including yesterday's cross-midnight carry-over;
- `build_reasons` / `build_card` enforce §18 one-bullet-per-groundable-feature: a feature
  with no matching fact produces **no bullet**, and every shipped bullet + rendered number
  carries a `fact_id`;
- `build_actions` wires the right CTA per card type and locale;
- `meters_text` / `travel_minutes` formatting;
- `attach_price_staleness` surfaces a stale price instead of silently rendering it (§5).
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from nexus_ai.contract import EntityCard
from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.search.cards import (
    attach_price_staleness,
    build_actions,
    build_card,
    build_reasons,
    compute_open,
    meters_text,
    synth_computed_facts,
    travel_minutes,
)
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

SUBJ = UUID("22222222-2222-2222-2222-222222222222")
NOW = datetime(2024, 1, 1, 12, 0, tzinfo=HK_TZ)   # Monday 12:00 HKT


# ------------------------------------------------------------- compute_open (§2 never guess)
def test_compute_open_no_hours_never_guesses():
    state = compute_open([], now=NOW)
    assert state["is_open"] is None
    assert state["text"] is None


def test_compute_open_within_hours_is_open():
    hours = [{"weekday": 0, "opens_at": "10:00", "closes_at": "22:00"}]
    state = compute_open(hours, now=NOW)
    assert state["is_open"] is True
    assert state["closes_hhmm"] == "22:00"


def test_compute_open_before_open_is_closed_with_next_time():
    hours = [{"weekday": 0, "opens_at": "14:00", "closes_at": "22:00"}]
    state = compute_open(hours, now=NOW)   # 12:00, before the 14:00 open
    assert state["is_open"] is False
    assert state["text"] == "Opens 14:00"


def test_compute_open_cross_midnight_open_late():
    hours = [{"weekday": 0, "opens_at": "22:00", "closes_at": "02:00", "crosses_midnight": True}]
    state = compute_open(hours, now=datetime(2024, 1, 1, 23, 0, tzinfo=HK_TZ))
    assert state["is_open"] is True
    assert state["closes_hhmm"] == "02:00"


def test_compute_open_yesterday_cross_midnight_carryover():
    hours = [{"weekday": 6, "opens_at": "22:00", "closes_at": "02:00", "crosses_midnight": True}]
    state = compute_open(hours, now=datetime(2024, 1, 1, 1, 0, tzinfo=HK_TZ))  # Mon 01:00
    assert state["is_open"] is True
    assert state["closes_hhmm"] == "02:00"


# ------------------------------------------------------------- formatting helpers
def test_meters_text():
    assert meters_text(None) == ""
    assert meters_text(300) == "300m"
    assert meters_text(46) == "50m"        # rounds to nearest 10m
    assert meters_text(44) == "40m"
    assert meters_text(1000) == "1.0km"
    assert meters_text(1280) == "1.3km"


def test_travel_minutes():
    assert travel_minutes(None) is None
    assert travel_minutes(800) == 10      # 80 m/min walking
    assert travel_minutes(40) == 1        # floor at 1 minute, never 0


# ------------------------------------------------------------- build_actions wiring
def test_build_actions_merchant_view_and_compare():
    actions = build_actions("merchant", SUBJ, {"slug": "sushi-zen"}, "zh-HK")
    assert [a.type for a in actions] == ["view", "compare"]
    assert actions[0].endpoint == "/api/v1/merchants/sushi-zen"
    assert actions[0].label == "查看"


def test_build_actions_merchant_agent_enabled_adds_ask():
    actions = build_actions("merchant", SUBJ, {"slug": "s", "ai_agent_enabled": True}, "en")
    assert [a.type for a in actions] == ["view", "ask", "compare"]
    assert actions[1].endpoint == "/ai/v1/merchant-agent/chat"


def test_build_actions_bookable_offering_reserves():
    actions = build_actions("product", SUBJ, {"slug": "p", "bookable": True,
                                              "merchant_id": "m1"}, "zh-HK")
    assert [a.type for a in actions] == ["view", "reserve", "compare"]
    reserve = next(a for a in actions if a.type == "reserve")
    assert reserve.endpoint == "/api/v1/reservations"
    assert reserve.payload["offering_id"] == str(SUBJ)


def test_build_actions_non_bookable_offering_adds_to_cart():
    actions = build_actions("product", SUBJ, {"slug": "p"}, "en")
    assert [a.type for a in actions] == ["view", "cart_add", "compare"]
    cart = next(a for a in actions if a.type == "cart_add")
    assert cart.endpoint == "/api/v1/carts/items"
    assert cart.payload["quantity"] == 1


# ------------------------------------------------------------- §18 reason grounding
def _ranking_cand(**kw) -> Candidate:
    return Candidate(subject_type="merchant", subject_id=str(SUBJ), merchant_id="m",
                     distance_m=300, rating=4.7, rating_count=120, popularity=0.9, **kw)


def test_build_reasons_grounds_every_bullet_and_skips_ungrounded():
    cand = _ranking_cand()
    bundle = FactBundle()
    computed = synth_computed_facts(bundle, cand, now=NOW, open_state=None,
                                    availability=None, query=None)
    scored = Scored(candidate=cand, score=0.5, organic_score=0.5, breakdown={},
                    contributions=[("distance", 0.1), ("quality", 0.2), ("popularity", 0.05)])
    reasons = build_reasons(cand, scored, bundle, locale="zh-HK", computed=computed,
                            open_state=None, reasons_from=(), query=None)
    labels = [r.label for r in reasons]
    assert "near_you" in labels   # distance -> distance_m fact
    assert "top_rated" in labels  # quality  -> rating fact
    assert "trending" not in labels  # popularity has no fact -> NO bullet (§18)
    assert all(r.fact_id is not None for r in reasons)


def test_build_reasons_district_without_fact_is_dropped():
    cand = _ranking_cand(district="銅鑼灣")   # district present, but no address fact
    bundle = FactBundle()
    computed = synth_computed_facts(bundle, cand, now=NOW, open_state=None,
                                    availability=None, query=None)
    scored = Scored(candidate=cand, score=0.5, organic_score=0.5, breakdown={},
                    contributions=[("distance", 0.1)])
    reasons = build_reasons(cand, scored, bundle, locale="zh-HK", computed=computed,
                            open_state=None, reasons_from=(), query=None)
    assert "district_match" not in [r.label for r in reasons]   # §4: no fact -> no bullet


def test_build_reasons_locale_copy():
    cand = _ranking_cand()
    bundle = FactBundle()
    computed = synth_computed_facts(bundle, cand, now=NOW, open_state=None,
                                    availability=None, query=None)
    scored = Scored(candidate=cand, score=0.5, organic_score=0.5, breakdown={},
                    contributions=[("distance", 0.1)])
    reasons = build_reasons(cand, scored, bundle, locale="en", computed=computed,
                            open_state=None, reasons_from=(), query=None)
    near = next(r for r in reasons if r.label == "near_you")
    assert near.text == "300m away"


# ------------------------------------------------------------- build_card end-to-end (§18)
def test_build_card_numbers_and_bullets_all_grounded():
    cand = _ranking_cand(price=180, budget_max=300)
    bundle = FactBundle()
    scored = Scored(candidate=cand, score=0.8, organic_score=0.8,
                    breakdown={"relevance": 0.8},
                    contributions=[("relevance", 0.5), ("distance", 0.2), ("quality", 0.1)])
    card = build_card(cand, scored, bundle, locale="zh-HK", query="壽司")
    # rendered numbers carry a fact_id
    assert card.rating["fact_id"]
    assert card.distance["fact_id"]
    # every bullet traces to a fact (§18)
    assert card.ai_match is not None
    assert all(r.fact_id is not None for r in card.ai_match.reasons)
    assert [a.type for a in card.actions] == ["view", "compare"]


def test_build_card_title_locale_order():
    cand = _ranking_cand()
    cand.raw = {"slug": "sushi-zen", "display_name": "Sushi Zen", "display_name_zh": "壽司"}
    bundle = FactBundle()
    scored = Scored(candidate=cand, score=0.5, organic_score=0.5, breakdown={}, contributions=[])
    zh = build_card(cand, scored, bundle, locale="zh-HK")
    en = build_card(cand, scored, FactBundle(), locale="en")
    assert zh.title.startswith("壽司")          # zh locale -> zh name first
    assert en.title.startswith("Sushi Zen")     # en locale -> en name first


# ------------------------------------------------------------- §5 stale price surfaced
def test_attach_price_staleness_surfaces_stale():
    bundle = FactBundle()
    price_fact = bundle.synth(subject_type="merchant", subject_id=SUBJ, attribute="price",
                              value={"amount": 100}, source="merchant", observed_at=NOW)
    price_fact.stale = True
    card = EntityCard(id=SUBJ, slug="x", title="X")
    attach_price_staleness(card, bundle, locale="zh-HK")
    assert card.ai_match is not None
    stale_reasons = [r for r in card.ai_match.reasons if r.label == "price_stale"]
    assert len(stale_reasons) == 1
    assert stale_reasons[0].fact_id == price_fact.fact_id   # the warning stays grounded
