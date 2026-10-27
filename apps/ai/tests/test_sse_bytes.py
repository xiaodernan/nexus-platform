"""Contract tests for the SSE serializer's compact JSON and async byte encoder (``api/sse``).

`test_sse.py` pins `sse_frame` / `parse_frames` / `assert_canonical_stream` / `plain`; this file
pins the two pieces underneath: `json_compact` (compact separators, no ASCII escaping, insertion
order preserved — the browser forwards upstream bytes verbatim) and `sse_bytes` (one UTF-8 frame
per event, in order, with a non-canonical name raising at iteration time).

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import pytest

import nexus_ai.api.sse as S


class TestJsonCompact:
    def test_compact_separators(self):
        assert S.json_compact({"a": 1, "b": 2}) == '{"a":1,"b":2}'

    def test_no_ascii_escaping(self):
        assert S.json_compact({"a": "中"}) == '{"a":"中"}'

    def test_insertion_order_is_preserved(self):
        assert S.json_compact({"b": 1, "a": 2}) == '{"b":1,"a":2}'

    def test_nested_structures(self):
        assert S.json_compact({"x": [1, {"y": True}]}) == '{"x":[1,{"y":true}]}'


async def _events(*pairs):
    for pair in pairs:
        yield pair


class TestSseBytes:
    async def test_one_utf8_frame_per_event_in_order(self):
        chunks = [b async for b in S.sse_bytes(_events(("status", {"stage": "searching"}),
                                                       ("done", {"agent_run_id": "r1"})))]
        assert chunks == [
            b'event: status\ndata: {"stage":"searching"}\n\n',
            b'event: done\ndata: {"agent_run_id":"r1"}\n\n',
        ]

    async def test_cjk_is_utf8_not_escaped(self):
        (chunk,) = [b async for b in S.sse_bytes(_events(("intent", {"q": "餐廳"})))]
        assert chunk == 'event: intent\ndata: {"q":"餐廳"}\n\n'.encode("utf-8")

    async def test_empty_iterator_yields_nothing(self):
        assert [b async for b in S.sse_bytes(_events())] == []

    async def test_a_non_canonical_event_raises_at_iteration(self):
        with pytest.raises(S.NonCanonicalEvent):
            [b async for b in S.sse_bytes(_events(("bogus", {})))]
