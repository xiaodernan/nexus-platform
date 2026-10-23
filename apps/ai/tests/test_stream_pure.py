"""Contract tests for the search stream's pure helpers (``api/stream``, §7/§116).

`search_stream_events` orchestrates the stream; these are the small pure pieces it stands on:
`stage_text` (per-locale, user-legible stage copy), `_context_geo` / `_context_now` (context
parsing) and `monotonic_ms` (the determinism seam). Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

import nexus_ai.api.stream as S


class TestStageText:
    def test_zh_hk(self):
        assert S.stage_text("zh-HK", "understanding") == "理解需求…"

    def test_zh_cn(self):
        assert S.stage_text("zh-CN", "comparing") == "比较这些选择…"

    def test_en(self):
        assert S.stage_text("en", "summarizing") == "Summarising…"

    def test_locale_variant_normalised(self):
        assert S.stage_text("en-US", "searching") == "Searching nearby merchants…"
        assert S.stage_text("zh-Hans", "comparing") == "比较这些选择…"

    def test_unknown_locale_falls_back_to_zh_hk(self):
        assert S.stage_text("fr", "understanding") == "理解需求…"

    def test_all_four_stages_exist_per_locale(self):
        for locale in ("zh-HK", "zh-CN", "en"):
            for stage in ("understanding", "searching", "comparing", "summarizing"):
                assert S.stage_text(locale, stage)

    def test_unknown_stage_raises(self):
        with pytest.raises(KeyError):
            S.stage_text("en", "bogus")


class TestContextGeo:
    def test_dict_is_returned(self):
        assert S._context_geo({"geo": {"lat": 1, "lng": 2}}) == {"lat": 1, "lng": 2}

    def test_non_dict_is_none(self):
        assert S._context_geo({"geo": "x"}) is None

    def test_empty(self):
        assert S._context_geo({}) is None


class TestContextNow:
    def test_datetime_passthrough(self):
        dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert S._context_now({"now": dt}) == dt

    def test_iso_z_is_parsed(self):
        assert S._context_now({"reference_time": "2026-01-01T00:00:00Z"}) == \
            datetime(2026, 1, 1, tzinfo=timezone.utc)

    def test_garbage_is_none(self):
        assert S._context_now({"now": "garbage"}) is None

    def test_empty(self):
        assert S._context_now({}) is None


class TestMonotonicMs:
    def test_is_a_positive_int(self):
        ms = S.monotonic_ms()
        assert isinstance(ms, int)
        assert ms > 0
