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


@router.get("/ai/v1/admin/behavior", include_in_schema=False)
async def behavior(request: Request, password: str = "", hours: int = 168):
    deps = Deps(request)
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
    recommendations = _recommendations(by_name, sessions, total)
    return {
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


def _recommendations(by_name: list[dict[str, Any]], sessions: list[dict[str, Any]], total: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    counts = {row["name"]: int(row["n"]) for row in by_name}
    searches = counts.get("search", 0)
    if total and searches and searches == int(total[0]["count"] if total else 0):
        out.append("the event stream is search-only: wire the §58 required names (view, click, reserve) "
                   "into the surfaces so the funnel becomes measurable")
    if searches and not counts.get("reserve"):
        out.append("search events exist but no reservation events: the search→reserve funnel step is "
                   "unwired or unused — instrument the booking path")
    if len(sessions) < 5:
        out.append("fewer than five distinct sessions in the window: thin traffic — drive behavior "
                   "simulation before reading trends as signal")
    if not out:
        out.append("the funnel carries all measured stages: keep collecting, revisit when the window doubles")
    return out
