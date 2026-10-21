"""One error envelope, built from the contract's own shape (D438).

`nexus_ai/contract.py` models the error envelope - `ErrorEnvelope` and `ErrorBody` - and
NOTHING used them: seven places across five route modules hand-built the same dict. A
shape that is written once and copied seven times is a shape that drifts, and a drift
here is invisible: the copy still looks like an envelope.

So the envelope is built here, from the model, and every route calls it.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from nexus_ai.contract import ErrorBody, ErrorEnvelope


def error_envelope(code: str, message: str, *, details: Any = None,
                   request_id: str | None = None) -> dict[str, Any]:
    """The §1 error body, from the contract's model - never hand-built."""
    return ErrorEnvelope(error=ErrorBody(
        code=code,
        message=message,
        details=details or {},
        request_id=request_id,
    )).model_dump(mode="json")


def error_response(code: str, message: str, *, details: Any = None,
                   request_id: str | None = None, status: int = 400) -> JSONResponse:
    """The error as a response, with the request id the service is carrying."""
    from nexus_ai.api import runs

    return JSONResponse(
        error_envelope(code, message, details=details,
                       request_id=request_id or (runs.current_request_id() or None)),
        status_code=status)
