"""D1512 — behavior analytics: honest OLS + measures derived from the actual numbers (§九)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.api.routes_behavior import _funnel_and_profiles, _funnel_recommendations, _project, _recommendations
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


# ---- D1569: the live funnel and reader profiles -------------------------------------------


def _shapes():
    return [
        {"session_id": "a", "actor": "user", "names": ["view", "click", "search"], "n": 3},
        {"session_id": "b", "actor": "user", "names": ["view"], "n": 1},
        {"session_id": "c", "actor": "agent", "names": ["view", "reserve"], "n": 2},
    ]


def test_funnel_counts_distinct_names_once_and_shares_are_crowd_shares():
    funnel, _ = _funnel_and_profiles(_shapes())
    assert [row["step"] for row in funnel] == ["view", "click", "search", "favorite", "reserve"]
    # every session views; the agent's second click... a session reaching a step twice still counts once
    assert funnel[0]["sessions"] == 3 and funnel[0]["share"] == 1.0
    assert funnel[1]["sessions"] == 1 and funnel[1]["share"] == 0.333
    # favorite is reached by nobody — an honest zero, not a mapped guess
    assert funnel[3] == {"step": "favorite", "sessions": 0, "share": 0.0}


def test_profiles_roll_up_depth_per_actor():
    _, profiles = _funnel_and_profiles(_shapes())
    assert profiles == [
        {"actor": "user", "sessions": 2, "avg_depth": 2.0},
        {"actor": "agent", "sessions": 1, "avg_depth": 2.0},
    ]


def test_funnel_recommendation_names_the_weakest_transition_once():
    funnel, _ = _funnel_and_profiles(_shapes())
    recs = _funnel_recommendations(funnel)
    assert len(recs) == 1
    assert "view→click keeps 33%" in recs[0]


def test_flat_pipeline_names_nothing():
    funnel = [{"step": s, "sessions": 3, "share": 1.0} for s in ("view", "click", "search")]
    assert _funnel_recommendations(funnel) == []
