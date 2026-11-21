"""D1520 — the live lane named an hour the reader refused, so the constraint died on the floor.

Two halves of one defect, found the same day the live lane started working (D1519):

1. `INTENT_EXTRACT_SYSTEM` described `time.quality` as free text (`<e.g. "open_late">`). The search
   plan reads exactly two prefixes from it — `open_late_after:` and `before:` (`service.py`) — and
   nothing else, so a live answer that named the hour any other way left `min_closing_hour` unbound
   and 「晚上九點之後」 filtered nothing. The prompt now names the vocabulary and the two shapes a
   location can take, because a model told the schema is free text will use free text.
2. `_hhmm_clock` accepted only the extractor's own `2100`. Measured live, the model answered
   `open_late_after:21:00` — the prefix matched, the reader answered None, and the filter was still
   never bound. The reader now takes both spellings of one clock.

Measured live (2026-11-22, `api.aizzz.xyz/v1` / `gpt-6.2-sol`, through `pipeline.understand` +
`plan_from_intent`):

    before   provider=openai  filters: category, district            (no min_closing_hour)
    after    provider=openai  filters: category, district, min_closing_hour=21:00
"""

from __future__ import annotations

from datetime import time

from nexus_ai.api import pipeline
from nexus_ai.api.pipeline import validate_intent
from nexus_ai.search.service import _hhmm_clock, plan_from_intent


# ------------------------------------------------------------------ the reader
def test_the_extractors_own_spelling_is_read():
    assert _hhmm_clock("2100") == time(21, 0)
    assert _hhmm_clock("930") == time(9, 30)


def test_the_colon_spelling_is_read_too():
    # the shape a person - and therefore a model - writes the clock in.
    assert _hhmm_clock("21:00") == time(21, 0)
    assert _hhmm_clock("9:30") == time(9, 30)


def test_an_unreadable_clock_still_answers_none():
    for bad in ("", None, "abc", "24:00", "2500", "21:60", "1:2:3", "21000"):
        assert _hhmm_clock(bad) is None, bad


# ------------------------------------------------------------------ the plan
def _plan(quality: str, *, kind: str = "open_late_after"):
    data = {
        "raw_query": "q", "intent": "discover_merchant", "category": "ramen",
        "location": {"type": "district", "value": "中環", "resolved": None, "radius_m": None},
        "time": {"type": "relative", "starts_at": None, "ends_at": None,
                 "raw": "晚上九點之後",
                 "quality": f"{kind}:{quality}"},
        "confidence": {"intent": 0.9}, "unknowns": [],
        "mentioned_entities": [], "excluded_ids": [],
    }
    return plan_from_intent(validate_intent(data), query="q", limit=8)


def test_the_after_quality_binds_the_closing_hour_in_both_spellings():
    for spelling in ("2100", "21:00"):
        plan = _plan(spelling)
        assert plan.open_late_after == time(21, 0), (spelling, plan.open_late_after)
        assert plan.filters.get("min_closing_hour") == time(21, 0), plan.filters


def test_the_before_quality_binds_the_opening_hour_in_both_spellings():
    for spelling in ("0800", "08:00"):
        plan = _plan(spelling, kind="before")
        assert plan.open_early_before == time(8, 0), (spelling, plan.open_early_before)
        assert plan.filters.get("max_opening_hour") == time(8, 0), plan.filters


def test_a_quality_the_reader_does_not_know_binds_nothing():
    # the free-text shape the prompt used to allow: honest, and it filters nothing.
    plan = _plan("21:00", kind="open_late")
    assert plan.open_late_after is None
    assert "min_closing_hour" not in (plan.filters or {}), plan.filters


# ------------------------------------------------------------------ the vocabulary on the wire
def test_the_prompt_names_the_two_prefixes_the_plan_reads():
    system = pipeline.INTENT_EXTRACT_SYSTEM
    assert "open_late_after:" in system, system
    assert "before:" in system, system


def test_the_prompt_names_the_two_location_shapes():
    system = pipeline.INTENT_EXTRACT_SYSTEM
    assert '"type": "district"' in system, system
    assert '"type": "nearby"' in system, system


def test_the_prompt_says_a_bare_hour_is_not_a_datetime():
    system = pipeline.INTENT_EXTRACT_SYSTEM
    assert "never in a datetime you invent" in system, system
