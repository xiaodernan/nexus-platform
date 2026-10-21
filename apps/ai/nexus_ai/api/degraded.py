"""One way to answer with a degradation, in the body AND in the header.

OBSERVABILITY.md §2: *"If `status='fallback'` the row must say which rung of the §105 ladder
was used, and the response carried `X-Nexus-Degraded` plus the UI '降級模式' badge. A
degraded answer that looks like a normal answer is an observability failure even when the
request returned 200."*

D451: the search set the header from its own response, and the other endpoints that carry a
`degraded` field did not set it at all - so a degraded recommendation or a degraded intent
came back with no header, which is the failure the paragraph above describes. The middleware
sets the header when the BACKEND is degraded, which is a different signal: the answer can be
degraded while the backend is fine (the model layer fell back to the rules).

So the header is written where the answer is written - in one place, so the two cannot
disagree.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def degraded_json(payload: dict[str, Any], *, status: int = 200) -> JSONResponse:
    """A JSON response that says whether it is degraded - in the body and the header."""
    degraded = bool(payload.get("degraded"))
    return JSONResponse(
        payload,
        headers={"x-nexus-degraded": "true" if degraded else "false"},
        status_code=status,
    )
