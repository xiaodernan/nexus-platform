"""The FastAPI app factory for the NEXUS AI service (port 8000, `/ai/v1/**`).

One seam — `create_app()` — wires every §7 route onto shared `Deps`, adds the request-id
contextvar middleware, and installs the error-envelope handlers so the *only* failure
shape a client ever sees from a non-stream endpoint is §1's
`{error:{code,message,details,request_id}}`. The DB pool is opened best-effort in the
lifespan: a missing/unreachable database never stops the app from serving the offline demo
surface (§105's floor), and closing it is just as forgiving.

`app = create_app()` at module scope is the uvicorn target (`app.main:app`), but importing
this module requires no env vars and touches no network.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Sequence

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from nexus_ai.api import errors, runs
from nexus_ai.api.deps import Deps, build_deps
from nexus_ai.api.tracing import parse_traceparent
from nexus_ai.api.routes_conversations import router as conversations_router
from nexus_ai.api.routes_discover import router as discover_router
from nexus_ai.api.routes_rag import router as rag_router
from nexus_ai.api.routes_search import router as search_router
from nexus_ai.api.routes_stream import router as stream_router
from nexus_ai.api.routes_system import router as system_router
from nexus_ai.api.routes_agent import router as agent_router
from nexus_ai.api.routes_actuator import router as actuator_router
from nexus_ai.db import pool as db_pool

log = logging.getLogger("nexus_ai.api.app")


def _envelope(code: str, message: str, *, details: Any = None,
              request_id: str | None = None, status: int) -> JSONResponse:
    # D438: the envelope is the contract's own shape (nexus_ai/contract.py), built in one
    # place - it used to be hand-built here and in six other places.
    return errors.error_response(code, message, details=details,
                                  request_id=request_id or (runs.current_request_id() or None),
                                  status=status)


def create_app(settings: Any | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        deps: Deps = app.state.deps
        try:  # offline is a first-class mode, never a boot failure (D4)
            await db_pool.connect(deps.settings)
        except Exception as exc:  # pragma: no cover - pool build is defensive already
            log.warning("database pool unavailable, serving offline demo: %s", exc)
        # D856: opt-in Eureka registration (NEXUS_AI_EUREKA_ENABLED=true). Default off —
        # the single-process boot registers nothing, like the monolith's default.
        # D1055: one line, once per process, naming the frozen prefix this process will send.
        # `prefix_contract.contract_stats()` was written "for tests, the probe and the admin
        # view" and no admin view ever read it - but the FIRST question about a low hit rate
        # is WHICH prefix produced these bytes, and the answer has to be in the log of the
        # process that sent them. That is the consumer; the tests are the second reader.
        from nexus_ai.models.prefix_contract import contract_stats
        _contract = contract_stats()
        log.info(
            "nexus_ai.prefix_contract version=%s sha=%s chars=%s approx_tokens=%s enabled=%s",
            _contract["version"], _contract["sha256"], _contract["chars"],
            _contract["approx_tokens"], _contract["enabled"],
        )
        from nexus_ai.discovery import maybe_register_eureka, stop_eureka
        eureka_registration = await maybe_register_eureka()
        yield
        # D969 — release the pooled AI→platform keep-alive connection on shutdown; stub-mode /
        # uninitialised factory is a no-op, so the offline first-class boot never fails on it.
        from nexus_ai.adapters.platform import aclose_platform_client
        await aclose_platform_client()
        # D974 — release the shared embedding HTTP client (never built on the hashing default,
        # so this is a no-op offline); the bounded LRU cache needs no teardown.
        from nexus_ai.models.embeddings import aclose_embedding_client
        await aclose_embedding_client()
        await stop_eureka(eureka_registration)
        try:
            await db_pool.dispose()
        except Exception:  # pragma: no cover
            log.debug("pool dispose failed", exc_info=True)

    app = FastAPI(title="NEXUS AI service", version="0.1.0", lifespan=lifespan)
    deps = build_deps(settings)
    app.state.deps = deps

    if deps.settings.cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(deps.settings.cors_origins),
            allow_methods=["*"], allow_headers=["*"],
        )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        rid = request.headers.get("x-request-id") or runs.new_id()
        runs.set_request_id(rid)
        try:
            response = await call_next(request)
        finally:
            pass
        response.headers["x-request-id"] = rid
        # D884: echo the trace the EDGE minted, never invent one of our own. A caller that reached
        # the AI directly (no gateway hop) brought no traceparent and gets no x-trace-id — an
        # absent correlation id is honest, a fabricated one is not.
        trace = parse_traceparent(request.headers.get("traceparent"))
        if trace:
            response.headers["x-trace-id"] = trace["trace_id"]
            response.headers["x-trace-parent-id"] = trace["parent_id"]
        if deps.backend_degraded():
            # D451: the backend being down degrades EVERY answer, whatever the route said
            # about its own response.
            response.headers["x-nexus-degraded"] = "true"
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        return _envelope("validation_error", "request body failed schema validation",
                         details={"errors": _jsonable_errors(exc.errors())}, status=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException):
        code = {401: "unauthorized", 403: "unauthorized", 404: "validation_error",
                422: "validation_error", 503: "ai_unavailable"}.get(
                    exc.status_code, "internal" if exc.status_code >= 500
                    else "validation_error")
        return _envelope(code, str(exc.detail), status=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        log.exception("unhandled error on %s", request.url.path)
        return _envelope("internal", "internal server error", status=500)

    for r in (search_router, stream_router, discover_router, rag_router,
              conversations_router, system_router, agent_router, actuator_router):
        app.include_router(r)

    @app.get("/")
    async def _root():
        return {"service": "nexus-ai", "docs": "/docs", "health": "/ai/v1/health"}

    return app


def _jsonable_errors(errors: Sequence[Any]) -> list[dict[str, Any]]:
    out = []
    for e in errors:
        out.append({
            "loc": [str(x) for x in e.get("loc", [])],
            "msg": str(e.get("msg", "")),
            "type": e.get("type"),
        })
    return out


app = create_app()
