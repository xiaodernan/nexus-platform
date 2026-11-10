"""D884 — W3C trace context: the AI service is a PARTICIPANT, not an origin.

The gateway's `EdgeTracingFilter` is the one component on this plane that MINTS trace ids. This
module only PARSES the standard `traceparent` request header so the FastAPI service can echo the
same trace id in its response and in the Spring Boot Admin info window. It deliberately does not:

  * invent a trace id when the caller brought none (that would be a second origin, and two origins
    is exactly what a trace is supposed to prevent);
  * mint child span ids, sample, or export anything (no collector exists on this plane);
  * pretend any Spring/Micrometer instrumentation is running inside Python.

W3C version 00, lowercase hex, non-zero ids — the same strict grammar the Java filter uses, so a
header the edge would reject cannot be accepted here and quietly laundered into a log line.
"""

from __future__ import annotations

import re

TRACEPARENT_HEADER = "traceparent"
TRACE_ID_HEADER = "x-trace-id"
PARENT_ID_HEADER = "x-trace-parent-id"

_W3C = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
_ZERO_TRACE = "0" * 32
_ZERO_PARENT = "0" * 16


def parse_traceparent(value: str | None) -> dict[str, str] | None:
    """Return {trace_id, parent_id, flags} for a valid W3C header, else None."""
    if not value:
        return None
    match = _W3C.match(value.strip())
    if not match:
        return None
    trace_id, parent_id, flags = match.groups()
    if trace_id == _ZERO_TRACE or parent_id == _ZERO_PARENT:
        return None
    return {"trace_id": trace_id, "parent_id": parent_id, "flags": flags}
