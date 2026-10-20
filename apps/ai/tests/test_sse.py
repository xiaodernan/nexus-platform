"""Framing-level unit tests: the SSE serializer is byte-exact and structurally canonical.

These guard the two properties D13 + the web BFF depend on: (1) the frame is
`event: <name>\\ndata: <compact json>\\n\\n` with UTF-8 / no ASCII escaping / key order
preserved, and (2) a non-canonical event name can never leave the process.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

import pytest

from nexus_ai.api.sse import (
    CANONICAL_STREAM_EVENTS, NonCanonicalEvent, assert_canonical_stream, parse_frames, plain, sse_frame)


def test_canonical_set_is_exactly_d13():
    assert CANONICAL_STREAM_EVENTS == frozenset(
        {"intent", "status", "results", "summary", "error", "done"})


def test_frame_exact_bytes():
    assert sse_frame("done", {"a": 1}) == 'event: done\ndata: {"a":1}\n\n'


def test_compact_no_ascii_escape_preserves_key_order():
    frame = sse_frame("summary", {"text": "找到 2 個", "b": 2, "a": 1})
    assert frame == 'event: summary\ndata: {"text":"找到 2 個","b":2,"a":1}\n\n'


def test_rejects_every_non_canonical_name():
    for name in ("thinking", "token", "reasoning", "progress", "RESULT", "", "citations"):
        with pytest.raises(NonCanonicalEvent):
            sse_frame(name, {})


def test_plain_projects_native_types():
    out = plain({"t": datetime(2026, 1, 1, tzinfo=timezone.utc),
                 "u": UUID(int=1), "m": Decimal("1.50"), "n": None,
                 "s": {1, 2}})
    assert out["t"] == "2026-01-01T00:00:00Z"
    assert out["u"] == "00000000-0000-0000-0000-000000000001"
    assert out["m"] == 1.5
    assert out["n"] is None
    assert sorted(out["s"]) == [1, 2]


def test_no_raw_newline_inside_data():
    # a newline in a string value is JSON-escaped, so a frame stays single-line data
    frame = sse_frame("summary", {"text": "line1\nline2"})
    assert re.fullmatch(r"event: summary\ndata: .*\n\n", frame, flags=re.S)
    assert frame.count("\n") == 3  # after name, after data, terminator only


def test_parse_and_assert_roundtrip():
    body = (sse_frame("status", {"stage": "understanding", "text": "理解需求…"})
            + sse_frame("intent", {"raw_query": "x"})
            + sse_frame("done", {"agent_run_id": "u", "latency_ms": 1, "cost_usd": 0.0,
                                 "degraded": False, "provider": "mock"}))
    events = assert_canonical_stream(body)
    assert [n for n, _ in events] == ["status", "intent", "done"]
    assert parse_frames(body) == events


def test_assert_rejects_stray_bytes():
    body = sse_frame("done", {"x": 1}) + "event: \n"
    with pytest.raises(AssertionError):
        assert_canonical_stream(body)
