"""API_CONTRACT §2 / §7.1 — the shared HTTP shapes, pinned as the contract they are.

`nexus_ai.contract` is imported by the routes *and* by the frontend's generated types, so
its behavior is interface behavior: strict models must reject a field the contract does not
name, lenient models must accept a newer server's extra field, money is a string amount in
HKD, and `Fact.effective_stale` is the one place expiry becomes a trust verdict.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from nexus_ai import contract as C


# --------------------------------------------------------------------------- strictness
def test_strict_models_reject_an_unlisted_field():
    with pytest.raises(ValidationError):
        C.GeoPoint(lat=22.3, lng=114.1, altitude=10)


def test_nested_strictness_is_enforced_through_the_parent():
    # SearchRequest is strict and so is its filters object: a typo two levels down must not
    # be dropped silently, because the route would then search without the filter.
    with pytest.raises(ValidationError):
        C.SearchRequest(query="x", filters={"district": "Central", "distirct": "typo"})


def test_search_request_rejects_an_unlisted_top_level_field():
    with pytest.raises(ValidationError):
        C.SearchRequest(query="x", limit=5, page=2)


def test_lenient_models_ignore_fields_a_newer_server_adds():
    card = C.EntityCard(id=uuid4(), slug="x", title="X", future_field="ignored")
    assert card.title == "X"
    resp = C.SearchResponse(items=[], took_ms=3, strategy="static", new_counter=9)
    assert resp.strategy == "static"


# --------------------------------------------------------------------------- money
def test_money_of_returns_none_for_none():
    assert C.Money.of(None) is None


def test_money_of_quantizes_to_two_places_and_keeps_a_string_amount():
    money = C.Money.of(Decimal("12.346"))
    assert money is not None
    assert money.amount == "12.35"
    assert isinstance(money.amount, str)  # never a float on the wire
    assert money.currency == "HKD"
    assert money.model is None


def test_money_of_accepts_float_and_int_and_names_the_model():
    assert C.Money.of(7).amount == "7.00"
    assert C.Money.of(7.5, currency="HKD", model="price_v2").model == "price_v2"


def test_money_rejects_an_unlisted_field():
    with pytest.raises(ValidationError):
        C.Money(amount="1.00", currency="HKD", note="cheap")


# --------------------------------------------------------------------------- fact staleness
def _fact(**kw):
    now = datetime.now(timezone.utc)
    base = dict(fact_id=uuid4(), subject_type="merchant", subject_id=uuid4(),
                attribute="price", value={"amount": "100.00"}, source="merchant",
                confidence=0.9, observed_at=now)
    base.update(kw)
    return C.Fact(**base)


def test_fact_is_stale_when_the_flag_says_so():
    assert _fact(stale=True).effective_stale is True


def test_fact_is_stale_once_expiry_has_passed_or_is_exactly_now():
    now = datetime.now(timezone.utc)
    assert _fact(expires_at=now - timedelta(seconds=1)).effective_stale is True
    assert _fact(expires_at=now).effective_stale is True


def test_fact_with_a_future_expiry_or_no_expiry_is_not_stale():
    now = datetime.now(timezone.utc)
    assert _fact(expires_at=now + timedelta(hours=1)).effective_stale is False
    assert _fact().effective_stale is False


def test_fact_source_is_the_closed_set():
    with pytest.raises(ValidationError):
        _fact(source="rumour")


def test_fact_value_accepts_any_json_shape():
    assert _fact(value=["a", 1]).value == ["a", 1]
    assert _fact(value=None).value is None


# --------------------------------------------------------------------------- intent
def test_intent_defaults_are_honest_about_what_is_unknown():
    intent = C.Intent(raw_query="找个地方吃饭")
    assert intent.intent == "unknown"
    assert intent.category is None
    assert intent.budget is None
    assert intent.party_size is None
    assert intent.unknowns == []
    assert intent.mentioned_entities == []
    assert intent.sort_preference == "relevance"
    assert intent.urgency == "normal"
    assert intent.language == "zh-HK"
    assert intent.location.value is None
    assert intent.time.type is None


def test_intent_lists_are_not_shared_between_instances():
    a = C.Intent(raw_query="a")
    b = C.Intent(raw_query="b")
    a.unknowns.append("time")
    assert b.unknowns == []


def test_intent_rejects_an_unknown_kind():
    with pytest.raises(ValidationError):
        C.Intent(raw_query="x", intent="book_a_flight")


def test_intent_rejects_an_unknown_sort_preference():
    with pytest.raises(ValidationError):
        C.Intent(raw_query="x", sort_preference="vibes")


def test_intent_urgency_is_the_three_way_contract():
    assert C.Intent(raw_query="x", urgency="now").urgency == "now"
    with pytest.raises(ValidationError):
        C.Intent(raw_query="x", urgency="asap")


def test_intent_location_partial_shape_is_valid():
    loc = C.IntentLocation(value="沙田", type="district")
    assert loc.resolved is None
    assert loc.radius_m is None
    with pytest.raises(ValidationError):
        C.IntentLocation(type="planet")


# --------------------------------------------------------------------------- search request
def test_search_request_defaults():
    req = C.SearchRequest(query="restaurant")
    assert req.limit == 20
    assert req.locale == "zh-HK"
    assert req.include_sponsored is True
    assert req.intent is None
    assert req.user_id is None
    assert isinstance(req.filters, C.SearchRequestFilters)
    assert req.filters.tags == []


def test_search_request_filters_defaults_and_kind_set():
    f = C.SearchRequestFilters()
    assert f.kind is None and f.attributes == {} and f.avoid == []
    with pytest.raises(ValidationError):
        C.SearchRequestFilters(kind="event")


def test_search_request_user_id_must_be_a_uuid():
    uid = uuid4()
    assert C.SearchRequest(query="x", user_id=uid).user_id == uid
    with pytest.raises(ValidationError):
        C.SearchRequest(query="x", user_id="not-a-uuid")


def test_search_request_nests_a_full_intent():
    intent = C.Intent(raw_query="铜锣湾的咖啡店", intent="discover_merchant",
                      category="cafe")
    req = C.SearchRequest(intent=intent, query="铜锣湾的咖啡店")
    assert req.intent is not None and req.intent.category == "cafe"


# --------------------------------------------------------------------------- cards + responses
def test_entity_card_defaults_are_the_render_contract():
    card = C.EntityCard(id=uuid4(), slug="merchant-x", title="X")
    assert card.card_type == "merchant"
    assert card.flags.sponsored is False and card.flags.demo is False
    assert card.actions == [] and card.facts == []
    assert card.score_breakdown == {}
    assert card.organic_rank is None


def test_entity_card_rejects_an_unknown_card_type():
    with pytest.raises(ValidationError):
        C.EntityCard(id=uuid4(), slug="x", title="X", card_type="voucher")


def test_entity_card_id_is_a_uuid_not_a_string():
    uid = uuid4()
    card = C.EntityCard(id=uid, slug="x", title="X")
    assert isinstance(card.id, UUID)
    with pytest.raises(ValidationError):
        C.EntityCard(id="merchant-1", slug="x", title="X")


def test_search_response_defaults_report_no_degradation():
    resp = C.SearchResponse(items=[], took_ms=1, strategy="static")
    assert resp.degraded is False
    assert resp.provider == "mock"
    assert resp.total_estimate == 0
    assert resp.relevance_floor_applied is True
    assert resp.facets == {}
    assert resp.next_cursor is None


def test_wire_names_are_snake_case_and_round_trip():
    # The contract fixes snake_case; a dump is what the frontend codes against.
    req = C.SearchRequest(query="x", include_sponsored=False, session_id="s1")
    dumped = req.model_dump()
    assert "include_sponsored" in dumped and "session_id" in dumped
    assert "includeSponsored" not in dumped
    assert C.SearchRequest(**dumped) == req


def test_understand_and_compare_shapes():
    u = C.UnderstandRequest(query="x")
    assert u.context == {}
    # D466: the answer IS the intent (the contract's §7 row), so the response model takes
    # the intent's fields at the root.
    r = C.UnderstandResponse(raw_query="x")
    assert r.follow_up_question is None and r.degraded is False
    row = C.CompareRow(attribute="price")
    assert row.cards == []
