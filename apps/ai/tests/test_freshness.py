"""§20 / AGENT_CONTRACT §5 — freshness is policy, not comments.

`nexus_ai.trust.freshness` is the TTL table the search service and the cart price-check
consult. Availability is real-time (ttl 0, never cached); a stale price must surface as
"價格可能已更新". This pins the contract so a TTL change or a wrong stale computation
cannot ship silently. All pure logic — no DB, no provider.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from nexus_ai.trust.freshness import (
    FRESHNESS_TTL, evaluate, mean_remaining_fraction, needs_reindex,
    remaining_fraction, stale_copy, ttl_for_attribute)

UTC = timezone.utc
NOW = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def test_ttl_for_known_attribute():
    assert ttl_for_attribute("price") == FRESHNESS_TTL["price"] == 6 * 3600


def test_ttl_resolves_alias():
    # offering/pricing columns alias into the canonical attribute
    assert ttl_for_attribute("avg_price_hkd") == FRESHNESS_TTL["price"]
    assert ttl_for_attribute("hours") == FRESHNESS_TTL["opening_hours"]


def test_ttl_for_unknown_attribute_defaults():
    assert ttl_for_attribute("something_new") == 24 * 3600


def test_availability_is_real_time_zero_ttl():
    assert ttl_for_attribute("availability") == 0.0
    f = evaluate(NOW, "availability")
    assert f.real_time is True
    assert f.expires_at is None


def test_fresh_value_is_not_stale_with_remaining_fraction():
    # observed 1h ago, price ttl 6h -> expires 5h from now
    observed = NOW - timedelta(hours=1)
    f = evaluate(observed, "price", now=NOW)
    assert f.stale is False
    assert f.expires_at == observed + timedelta(seconds=FRESHNESS_TTL["price"])
    # 5/6 of the window remains
    assert abs(f.remaining_fraction - (5 / 6)) < 1e-6


def test_stale_value_is_stale_with_zero_remaining():
    observed = NOW - timedelta(hours=10)  # past the 6h price ttl
    f = evaluate(observed, "price", now=NOW)
    assert f.stale is True
    assert f.remaining_fraction == 0.0


def test_unknown_observation_is_stale():
    f = evaluate(None, "price", now=NOW)
    assert f.stale is True
    assert f.remaining_fraction == 0.0


def test_forced_stale_overrides_freshness():
    observed = NOW - timedelta(minutes=1)  # well within ttl
    f = evaluate(observed, "price", now=NOW, forced_stale=True)
    assert f.stale is True


def test_the_stale_flag_is_the_evaluation_s():
    # D500: `is_stale` was a public export that no production code called - the dead
    # constant census counts a TEST's read as a read, so it survived. The evaluation
    # already answers the question (`evaluate(...).stale`), so the wrapper is gone.
    assert evaluate(NOW - timedelta(hours=10), "price", now=NOW).stale is True
    assert evaluate(NOW - timedelta(hours=1), "price", now=NOW).stale is False


def test_remaining_fraction_convenience():
    assert remaining_fraction(None, "price", now=NOW) == 0.0
    assert 0 < remaining_fraction(NOW - timedelta(hours=1), "price", now=NOW) <= 1.0


def test_explicit_expires_at_is_used():
    expires = NOW + timedelta(hours=2)
    f = evaluate(NOW, "price", now=NOW, expires_at=expires)
    assert f.expires_at == expires
    assert f.stale is False


def test_stale_copy_localisation_and_fallback():
    assert stale_copy("zh-HK") == "價格可能已更新"
    assert stale_copy("zh-CN") == "价格可能已更新"
    assert stale_copy("en") == "price may have changed"
    assert stale_copy("fr") == "價格可能已更新"  # unknown locale falls back to zh-HK


def test_mean_remaining_fraction_empty_is_none():
    assert mean_remaining_fraction([], now=NOW) is None


def test_mean_remaining_fraction_averages_rows():
    rows = [
        {"observed_at": NOW - timedelta(hours=1), "attribute": "price"},
        {"observed_at": NOW - timedelta(hours=1), "attribute": "price"},
    ]
    mean = mean_remaining_fraction(rows, now=NOW)
    assert mean is not None
    assert abs(mean - (5 / 6)) < 1e-6


def test_needs_reindex_triggers():
    gen = NOW - timedelta(hours=1)
    # within 24h, few new reviews -> no recompute
    assert needs_reindex(2, gen, now=NOW) is False
    # >=5 new reviews forces recompute regardless of clock
    assert needs_reindex(5, gen, now=NOW) is True
    # past the 24h window
    assert needs_reindex(2, NOW - timedelta(hours=30), now=NOW) is True
    # never generated
    assert needs_reindex(0, None, now=NOW) is True
