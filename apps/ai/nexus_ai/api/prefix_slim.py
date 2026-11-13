"""Deterministic prefix preparation for the summary call.

Outputs a byte-stable slim prefix for the model: it carries the merchant ID,
title, category, price, rating, distance and hours, but NOT the per-call
fields (ULIDs, timestamps) that change on every seed reload. Two consecutive
calls on the same merchant set therefore produce the SAME bytes, letting the
upstream's prefix cache absorb nearly every token of the prompt.

Deterministic by construction — keys are inserted in fixed order, values are `str`, `int`
or a block copied verbatim from the card builder, and the JSON is produced by
`json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`.

D1055: this module is a PROJECTION, not a second builder. It used to re-derive the rating
block (`_num` here, `or 0` there) and so carried a second copy of a rule whose whole content
is the count question - the copy that would have published `{"value": 4.2, "count": 0}` for a
merchant with a stale average and no reviews. It now calls `search.cards.rating_block`, the
one writer, which is also why `test_a_subject_with_no_reviews_prints_no_rating_score.py`
permits this file to assign a `rating` key: the door it holds is that nobody *chooses* the
number twice.
"""
from __future__ import annotations

from typing import Any

from nexus_ai.search.cards import rating_block


def _str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _num(v: Any) -> float | int | None:
    try:
        n = float(v)
        if n != n:  # NaN
            return None
        return n
    except (TypeError, ValueError):
        return None


def _dict_pick(d: Any, *keep: str) -> dict[str, Any]:
    if not isinstance(d, dict):
        return {}
    out: dict[str, Any] = {}
    for key in keep:
        if key in d:
            out[key] = d[key]
    return out


def slim_records_for_model(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    slim: list[dict[str, Any]] = []
    for r in (records or []):
        entry: dict[str, Any] = {}
        mid = _str((r.get("id") if isinstance(r, dict) else None))
        if mid:
            entry["id"] = mid
        else:
            continue
        title = _str(r.get("title"))
        if not title:
            continue
        entry["title"] = title

        subtitle = _str(r.get("subtitle"))
        if subtitle:
            entry["subtitle"] = subtitle

        tags = r.get("tags")
        if isinstance(tags, list):
            entry["tags"] = [_str(t) for t in tags if _str(t)]

        price = _dict_pick(r.get("price"), "amount", "currency", "model")
        if price:
            entry["price"] = price

        rating = r.get("rating")
        # D1055: the block is the builder's answer, re-asked - not a second opinion on it.
        # The guard is the null, because `rating_block` answers `None` for a merchant with no
        # score and the projection carries no key at all rather than a null one.
        if isinstance(rating, dict) and rating.get("value") is not None:
            entry["rating"] = rating_block(rating.get("value"), rating.get("count"))

        dist_raw = r.get("distance")
        if isinstance(dist_raw, dict):
            dist_val = _num(dist_raw.get("meters"))
            if dist_val is not None:
                entry["distance_m"] = dist_val
        elif dist_raw is not None:
            entry["distance_m"] = _num(dist_raw)

        open_block = r.get("open")
        if isinstance(open_block, dict):
            entry["open_now"] = bool(open_block.get("is_open"))

        ai_match = r.get("ai_match")
        if isinstance(ai_match, dict):
            score = _num(ai_match.get("score"))
            if score is not None:
                entry["ai_match"] = {"score": score}

        slim.append(entry)
        if len(slim) >= 10:
            break
    return slim
