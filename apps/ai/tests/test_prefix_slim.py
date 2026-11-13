"""D1043 - the summary prefix slimmer: byte-stability is the caching contract.

The provider prefix cache keys on the exact bytes of the request prefix. The raw
card bundle carries per-call fields (ULIDs, observed_at/expires_at timestamps, fact ids)
that change on every seed reload, which busts the upstream cache on every call.
`slim_records_for_model` keeps the merchant-needable identity + price/rating/distance and
drops everything volatile, deterministically.
"""

from __future__ import annotations

import json

from nexus_ai.api.prefix_slim import slim_records_for_model

MERCHANT = {
    "card_type": "merchant",
    "id": "m-food-thai-00",
    "slug": "real-thai-house",
    "title": "Real Thai House",
    "subtitle": "Thai-style cuisine",
    "href": "/m/real-thai-house",
    "image": {"url": "/media/real-thai-house.svg", "alt": "scale icon", "credit": "synthetic"},
    "tags": ["thai", "curry"],
    "price": {"amount": "78.00", "currency": "HKD", "model": "per_person"},
    "rating": {"value": 4.6, "count": 921},
    "distance": {"meters": 280, "travel_minutes": 4, "text": "280 m"},
    "open": {"is_open": True, "opens_at": "07:30", "closes_at": "22:00",
             "as_of": "2026-11-13T10:30:00.000Z", "source_fact_id": "f-xyz-001"},
    "availability": {"status": "available", "next_slot": "available"},
    "ai_match": {"score": 0.91, "reasons": [
        {"label": "price_known", "text": "$78", "value": "78.00", "fact_id": "f-xyz-002"},
    ]},
    "actions": [{"type": "call", "label": "call",
                 "endpoint": "/synthetic-call-endpoint", "method": "POST"}],
    "facts": [
        {"fact_id": "f-xyz-001", "subject_type": "merchant", "subject_id": "m-food-thai-00",
         "attribute": "business_hours",
         "value": {"mon": "10:00-23:00"},
         "source": "merchant", "confidence": 0.98,
         "observed_at": "2026-11-13T10:30:00.000Z",
         "expires_at": "2026-11-14T10:30:00.000Z", "stale": False},
    ],
    "flags": {"demo": True, "sponsored": False, "unverified": False},
    "geo": {"lat": 22.41, "lng": 114.15},
    "group": None,
}


def _records() -> list[dict]:
    return [dict(MERCHANT), dict(MERCHANT, id="m-hotpot-02", title="Hot Pot")]


def test_slim_drops_volatile_and_keeps_identity():
    out = slim_records_for_model(_records())
    assert [r["id"] for r in out] == ["m-food-thai-00", "m-hotpot-02"]
    for r in out:
        assert "facts" not in r and "observed_at" not in json.dumps(r)
        assert "fact_id" not in json.dumps(r)
        assert "actions" not in r
        assert "as_of" not in json.dumps(r)
        assert r["open_now"] is True
        assert r["ai_match"]["score"] == 0.91


def test_slim_is_byte_deterministic_across_calls():
    a = slim_records_for_model(_records())
    b = slim_records_for_model(_records())
    assert json.dumps(a, sort_keys=True, ensure_ascii=False, separators=(",", ":")) == \
           json.dumps(b, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def test_slim_skips_unidentifiable_records_and_caps_at_ten():
    records = [dict(MERCHANT, id=None, title=None)] + [
        dict(MERCHANT, id=f"m-{i}", title=f"T{i}") for i in range(12)
    ]
    out = slim_records_for_model(records)
    assert len(out) == 10
    assert all(r["id"] and r["title"] for r in out)


def test_slim_tolerates_garbage_shapes():
    out = slim_records_for_model([{}, {"title": "keep me"}, {"id": 42, "title": "  pad  "}])
    assert [r["id"] for r in out] == ["42"]
    assert out[0]["title"] == "pad"
    assert slim_records_for_model([]) == []
