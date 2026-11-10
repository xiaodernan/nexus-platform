"""The FastAPI window into the Spring Boot Admin protocol.

NEXUS-AI is the one service on the plane that is Python, and Spring Boot Admin — the cloud
plane's one window (D859/D872) — probes every Eureka-registered instance through the actuator
path: `/actuator/health`, `/actuator/info`. Without them the admin shows the AI instance as
UNKNOWN/UNREACHABLE no matter how healthy it actually is.

These are the ONLY two endpoints this service adopts from that protocol; nothing else moves:
`/actuator/health` returns the exact shape Spring Boot Admin parses (`{"status":"UP"}`), and
`/actuator/info` reports the service honestly as a FastAPI app (never pretending to be Spring).
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(include_in_schema=False, tags=["actuator"])


@router.get("/actuator/health")
async def actuator_health():
    return JSONResponse({"status": "UP", "groups": ["liveness", "readiness"]})


@router.get("/actuator/info")
async def actuator_info():
    return JSONResponse(
        {
            "app": {
                "name": "nexus-ai",
                "version": "0.1.0",
                "stack": "fastapi",
                "health_profile": "mock",  # live demo plane runs mock; this is a fact of the deploy, not a promise
            },
            # D884: what this service actually does with trace context. Participant, not origin:
            # it parses the W3C header the gateway propagates and echoes its trace id; it mints
            # nothing, samples nothing and exports nothing.
            "tracing": {
                "propagation": "w3c-traceparent",
                "role": "participant",
                "mints_trace_ids": False,
                "exports_spans": False,
            },
        }
    )


@router.get("/actuator")
async def actuator_index():
    return JSONResponse(
        {
            "_links": {
                "health": {"href": "/actuator/health", "templated": False},
                "info": {"href": "/actuator/info", "templated": False},
            }
        }
    )
