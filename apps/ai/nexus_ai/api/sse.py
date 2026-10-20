"""SSE framing for the canonical search stream — API_CONTRACT §7 + lead ruling D13.

D13 fixes the surface: the stream events are EXACTLY
`intent | status | results | summary | error | done`, with `agent_run_id` inside `done`.
This module is the single serializer for every frame the service emits, and it hard-
refuses any other event name — "no event outside the canonical set" is structural here,
not a convention.

Framing is byte-compatible with the web BFF's own `frame()` helper
(`apps/web/app/api/nexus/ai/stream/route.ts`): `event: <name>\\ndata: <compact json>\\n\\n`,
UTF-8, no ASCII escaping, `,`/`:` separators, insertion order preserved (never sorted —
the browser forwards upstream bytes verbatim, and JSON.parse ignores key order anyway).
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, AsyncIterator, Iterable, Tuple
from uuid import UUID

CANONICAL_STREAM_EVENTS: frozenset[str] = frozenset(
    {"intent", "status", "results", "summary", "error", "done"})

#: emission order of the happy-path stream (status recurs between stages)
STREAM_STAGE_ORDER: tuple[str, ...] = ("understanding", "searching", "comparing",
                                       "summarizing")


class NonCanonicalEvent(ValueError):
    """Raised when anything tries to emit an event name D13 does not allow."""


def plain(value: Any) -> Any:
    """JSON-safe projection: pydantic models, uuids, datetimes, decimals, tuples."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") \
            if value.tzinfo else value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return plain(dump(mode="json"))
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)) or isinstance(value, Iterable):
        return [plain(v) for v in value]
    return str(value)


def json_compact(data: Any) -> str:
    return json.dumps(plain(data), ensure_ascii=False, separators=(",", ":"))


def sse_frame(event: str, data: Any) -> str:
    """One canonical frame: `event: <name>\\ndata: <json>\\n\\n`."""
    if event not in CANONICAL_STREAM_EVENTS:
        raise NonCanonicalEvent(
            f"event {event!r} is not in the canonical D13 set "
            f"{sorted(CANONICAL_STREAM_EVENTS)}")
    return f"event: {event}\ndata: {json_compact(data)}\n\n"


async def sse_bytes(events: AsyncIterator[Tuple[str, Any]]) -> AsyncIterator[bytes]:
    """Encode an (event, data) iterator as an SSE byte stream."""
    async for name, data in events:
        yield sse_frame(name, data).encode("utf-8")


# a frame is `event: <name>\ndata: <json>\n\n`; compact JSON never contains a raw
# newline (json.dumps escapes them), so `.` must NOT cross lines — no DOTALL.
_FRAME_RE = re.compile(r"event: ([a-z_]+)\ndata: (.*)\n\n")


def parse_frames(raw: str) -> list[Tuple[str, Any]]:
    """Decode an SSE body for tests/clients: [(event, data), ...] in order."""
    out: list[Tuple[str, Any]] = []
    for m in _FRAME_RE.finditer(raw):
        out.append((m.group(1), json.loads(m.group(2))))
    return out


def assert_canonical_stream(raw: str) -> list[Tuple[str, Any]]:
    """Test/CI helper: the body parses as complete canonical frames, nothing else."""
    events = parse_frames(raw)
    assert events, "stream emitted no frames"
    for name, _data in events:
        assert name in CANONICAL_STREAM_EVENTS, f"non-canonical event {name!r}"
    # the whole body must be consumed by the frame regex: no stray bytes between frames
    assert sum(len(sse_frame(n, d)) for n, d in events) == len(raw)
    return events
