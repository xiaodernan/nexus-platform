"""Root Makefile launches the AI service as `uvicorn app.main:app` from `apps/ai`;
this thin shim just re-exports the real ASGI app built in `nexus_ai.api.app`."""

from __future__ import annotations

from nexus_ai.api.app import app, create_app

__all__ = ["app", "create_app"]
