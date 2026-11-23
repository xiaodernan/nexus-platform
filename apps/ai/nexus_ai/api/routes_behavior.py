"""D370 — the behavior-analytics read: per-user event streams, stats, trend projection.

§九 of the product directive: an admin view (password 123) that watches every user's
behavior, computes stats and a trend projection, and derives the next optimization move.
The data is the §58 events table — real rows the demo plane has accumulated, never
fabricated. The gate is the password compared in plain sight (the owner publishes it);
the read is SELECT-only against the demo database.

Trend projection: per-day event counts over the observed window, a least-squares line,
and the next seven days projected from it — honest arithmetic, not a promise.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request

from nexus_ai.api import errors
from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.deps import Deps

router = APIRouter()
log = logging.getLogger("nexus_ai.behavior")

ADMIN_PASSWORD = "123"

# D1569 — the engagement pipeline the live funnel measures, in order. Shape parity with the
# web demo payload (same {step, sessions, share} rows); the STEP NAMES follow the events
# table's own engagement vocabulary, so a live zero is a real zero, never a mapped guess.
FUNNEL_STEPS = ("view", "click", "search", "favorite", "reserve")


@router.get("/ai/v1/admin/behavior", include_in_schema=False)
async def behavior(request: Request, password: str = "", hours: int = 168):
    deps: Deps = request.app.state.deps
    if password != ADMIN_PASSWORD:
        return errors.error_response("admin_password", "password 123 required", status=403)
    db = deps.database()
    if db is None:
        return degraded_json(
            errors.error_envelope("database_unavailable", "the events plane is not reachable"),
            status=503,
        )
    hours = max(1, min(hours, 24 * 30))
    window = f"interval '{hours} hours'"
    try:
        daily = [dict(r) for r in await db.fetch(
            f"""SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day, count(*) AS n
                FROM events WHERE occurred_at > now() - {window}
                GROUP BY 1 ORDER BY 1""")]
        by_name = [dict(r) for r in await db.fetch(
            f"""SELECT name, count(*) AS n FROM events WHERE occurred_at > now() - {window}
                GROUP BY 1 ORDER BY n DESC""")]
        sessions = [dict(r) for r in await db.fetch(
            f"""SELECT session_id, count(*) AS n,
                       min(occurred_at) AS first_at, max(occurred_at) AS last_at
                FROM events WHERE occurred_at > now() - {window} AND session_id IS NOT NULL
                GROUP BY 1 ORDER BY n DESC LIMIT 25""")]
        session_shapes = [dict(r) for r in await db.fetch(
            f"""SELECT session_id,
                       MIN(COALESCE(actor_type, 'unknown')) AS actor,
                       array_agg(DISTINCT name) AS names,
                       count(*) AS n
                FROM events WHERE occurred_at > now() - {window} AND session_id IS NOT NULL
                GROUP BY session_id""")]
        hourly = [dict(r) for r in await db.fetch(
            f"""SELECT EXTRACT(HOUR FROM occurred_at)::int AS hour, count(*) AS n
                FROM events WHERE occurred_at > now() - {window}
                GROUP BY 1 ORDER BY 1""")]
        total = [dict(r) for r in await db.fetch(
            f"""SELECT count(*) AS count FROM events WHERE occurred_at > now() - {window}""")]
    except Exception as exc:  # the demo plane can close under us
        log.warning("behavior query failed: %s", exc)
        return degraded_json(
            errors.error_envelope("query_failed", str(exc)[:200]),
            status=503,
        )
    daily_counts = [(row["day"], int(row["n"])) for row in daily]
    projection = _project(daily_counts, 7)
    funnel, profiles = _funnel_and_profiles(session_shapes)
    recommendations = _recommendations(by_name, sessions, total, daily_counts, projection, hourly)
    recommendations.extend(_funnel_recommendations(funnel))
    return {
        "funnel": funnel,
        "profiles": profiles,
        "window_hours": hours,
        "total_events": int(total[0]["count"]) if total else 0,
        "daily": daily_counts,
        "projection_next_7_days": projection,
        "hourly": hourly,
        "top_events": by_name,
        "sessions": sessions,
        "recommendations": recommendations,
        "degraded": False,
    }


async def _rows(conn: Any, sql: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(sql)
    return [dict(row) for row in rows]


def _project(daily: list[tuple[str, int]], days: int) -> list[dict[str, Any]]:
    """Least-squares line over the observed days, extended `days` ahead.

    Fewer than two observed days is a projection of nothing — an honest empty list,
    because a line through one point is a promise the data never made.
    """
    if len(daily) < 2:
        return []
    xs = list(range(len(daily)))
    ys = [n for _, n in daily]
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return []
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom
    intercept = mean_y - slope * mean_x
    out = []
    for i in range(days):
        x = n + i
        out.append({"day_index": x, "projected": max(0, round(intercept + slope * x))})
    return out


def _funnel_and_profiles(
    session_shapes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """D1569 — the drop-off funnel and per-actor depth, from real session shapes.

    A session "reached" a step when its DISTINCT name set contains it (double clicks count
    once). Shares are over ALL sessions in the window, not the previous step's, so the
    funnel reads as crowd shares rather than conditional conversions.
    """
    total_sessions = len(session_shapes)
    funnel = []
    for step in FUNNEL_STEPS:
        reached = sum(1 for row in session_shapes if step in (row.get("names") or []))
        share = round(reached / total_sessions, 3) if total_sessions else 0.0
        funnel.append({"step": step, "sessions": reached, "share": share})
    profiles: dict[str, dict[str, Any]] = {}
    for row in session_shapes:
        actor = str(row.get("actor") or "unknown")
        p = profiles.setdefault(actor, {"actor": actor, "sessions": 0, "depth_sum": 0})
        p["sessions"] += 1
        p["depth_sum"] += int(row.get("n") or 0)
    out = [
        {"actor": actor, "sessions": p["sessions"],
         "avg_depth": round(p["depth_sum"] / p["sessions"], 2)}
        for actor, p in profiles.items()
    ]
    out.sort(key=lambda r: -r["sessions"])
    return funnel, out


def _funnel_recommendations(funnel: list[dict[str, Any]]) -> list[str]:
    """Name the weakest transition — the sharpest share drop — with its keep-rate.

    One recommendation, the argmax over the pipeline: the step where the crowd falls off
    hardest is the first thing an operator should work on. A pipeline nobody reaches past
    the first step names the view→next drop; a flat pipeline names nothing.
    """
    drops = [
        (funnel[i - 1]["share"] - funnel[i]["share"], i)
        for i in range(1, len(funnel))
    ]
    if not drops:
        return []
    drop, i = max(drops)
    if drop <= 0:
        return []
    kept = round(100 * funnel[i]["share"])
    return [
        f"funnel weakest transition: {funnel[i - 1]['step']}→{funnel[i]['step']} "
        f"keeps {kept}% of sessions — the first thing an operator should work on"
    ]


def _recommendations(
    by_name: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    total: list[dict[str, Any]],
    daily: list[tuple[str, int]] | None = None,
    projection: list[dict[str, Any]] | None = None,
    hourly: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Next-step measures DERIVED from the measured numbers (§九).

    D1512: these used to be four canned strings selected by boolean gates while the UI
    promised "data-derived next actions". Every measure now embeds the actual computed
    slope, peak hour, funnel counts and session density. Pure function — unit-testable
    with no database. No number is invented: when the input is absent, the measure is
    omitted rather than guessed.
    """
    out: list[str] = []
    counts = {str(row.get("name")): int(row.get("n") or 0) for row in by_name}
    searches = counts.get("search", 0)
    reserves = counts.get("reserve", 0)
    grand = int(total[0].get("count") or 0) if total else 0

    # 1) trend from the real least-squares projection
    proj = projection or []
    if len(proj) >= 2:
        first, last = int(proj[0].get("projected") or 0), int(proj[-1].get("projected") or 0)
        delta = last - first
        direction = "up" if delta > 0 else "down" if delta < 0 else "flat"
        out.append(
            f"7-day least-squares projection runs {first}→{last} events/day ({direction} {abs(delta)}): "
            f"{'capacity planning should follow the rising load' if delta > 0 else 'hold capacity; the window is steady or falling'}"
        )

    # 2) peak hour from the real hourly histogram
    hours = hourly or []
    if hours:
        peak = max(hours, key=lambda r: int(r.get("n") or 0))
        peak_n = int(peak.get("n") or 0)
        share = round(100 * peak_n / grand) if grand else 0
        if peak_n > 0:
            out.append(
                f"peak hour {int(peak.get('hour') or 0):02d}:00 carries {peak_n} events ({share}% of the window): "
                f"inspect that hour's journeys before changing the funnel"
            )

    # 3) funnel from real per-event counts
    if grand:
        if searches == grand:
            out.append(
                f"all {grand} events are 'search' (100%); wire view/click/reserve into the surfaces "
                f"so the funnel beyond search becomes measurable"
            )
        elif searches and not reserves:
            out.append(
                f"{searches} search events ({round(100 * searches / grand)}%) but 0 reserve events: "
                f"the search→reserve step is unwired or unused — instrument the booking path"
            )
        elif searches and reserves:
            out.append(
                f"funnel carries {searches} search and {reserves} reserve events "
                f"({round(100 * reserves / searches)}% search→reserve): keep collecting, revisit when the window doubles"
            )

    # 4) session density from the real session rows
    if sessions:
        n = len(sessions)
        density = round(grand / n, 1) if grand else 0.0
        out.append(
            f"{n} session(s) in the window at {density} events/session: "
            f"{'thin traffic — drive behavior simulation before reading trends as signal' if n < 5 else 'enough sessions to read the trend as signal'}"
        )

    if not out:
        out.append("no events in this window: the read is honest but has no signal to derive measures from")
    return out

