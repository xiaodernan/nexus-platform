"""D1512 — behavior analytics: honest OLS + measures derived from the actual numbers (§九)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.api.routes_behavior import _project, _recommendations
from nexus_ai.config import Settings


def test_projection_needs_two_days():
    assert _project([("2026-01-01", 5)], 7) == []


def test_projection_is_a_real_least_squares_line():
    daily = [("d0", 0), ("d1", 2), ("d2", 4), ("d3", 6)]
    p = _project(daily, 3)
    assert len(p) == 3
    # a perfect slope-2 line continued from x=4: 8, 10, 12
    assert [row["projected"] for row in p] == [8, 10, 12]


def test_projection_clamps_negative_to_zero():
    daily = [("d0", 10), ("d1", 5), ("d2", 0)]
    p = _project(daily, 2)
    assert all(row["projected"] >= 0 for row in p)


def test_password_gate_returns_403():
    with TestClient(create_app(Settings(llm_provider="mock", embedding_provider="hashing",
                                        database_url="", internal_token=""))) as c:
        r = c.get("/ai/v1/admin/behavior", params={"password": "wrong"})
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "admin_password"


def _stats():
    daily = [("d0", 2), ("d1", 4), ("d2", 6)]
    proj = _project(daily, 3)
    by_name = [{"name": "search", "n": 9}, {"name": "reserve", "n": 3}]
    sessions = [{"session_id": f"s{i}", "n": 2} for i in range(6)]
    total = [{"count": 12}]
    hourly = [{"hour": 9, "n": 7}, {"hour": 20, "n": 5}]
    return by_name, sessions, total, daily, proj, hourly


def test_measures_embed_real_numbers():
    measures = _recommendations(*_stats())
    assert len(measures) >= 3
    joined = " ".join(measures)
    # trend numbers from the projection, peak hour share, funnel counts, session density
    assert "→" in joined and "events/day" in joined
    assert "09:00" in joined and "7" in joined and "58%" in joined
    assert "9 search" in joined and "3 reserve" in joined and "33%" in joined
    assert "6 session" in joined and "2.0 events/session" in joined


def test_empty_window_is_honest():
    measures = _recommendations([], [], [{"count": 0}], [], [], [])
    assert len(measures) == 1
    assert "no events" in measures[0]
