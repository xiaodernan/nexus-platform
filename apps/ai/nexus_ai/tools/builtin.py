"""Read-only tools registered through the registry, wired to the real backend path.

AGENT_CONTRACT §3's canonical tool set names 24 tools. Most of them are not implementable
honestly on this plane yet (they need LLM dispatch, platform adapters, or database roles
the offline path deliberately does not hold). A registry that registers nothing reads as
helpful scaffolding; one that registers a single tool that actually answers reads as a
delivery unit. This file ships that one.

* `get_business_hours(merchant_id?)` - the one tool whose answer exists on every plane
  (Postgres through `PostgresBackend.hours()`, demo catalogue through the static backend's
  `_hours` table). The input is the merchant id; the output is the merchant's weekly
  `business_hours` rows with weekday/opening/closing/cross-midnight exactly as the corpus
  writes them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Mapping

from nexus_ai.tools.registry import (
    PERMISSION_READ,
    Registry,
    ToolSpec,
)

if TYPE_CHECKING:
    from nexus_ai.search.service import SearchBackend


def build_get_business_hours(registry: Registry, backend: SearchBackend) -> ToolSpec:
    """Register the `get_business_hours` read tool against `backend`."""

    spec = ToolSpec(
        name="get_business_hours",
        version="1",
        description=(
            "Read the configured opening hours for ONE merchant. "
            "Returns the merchant's business_hours rows exactly as the corpus writes them "
            "(weekday, opens_at, closes_at, crosses_midnight). Never invents an hours row: "
            "a merchant with no hours row answers with an empty list, not a fabricated one."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "merchant_id": {"type": "string", "minLength": 1},
            },
            "required": ["merchant_id"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "merchant_id": {"type": "string"},
                "weekly_hours": {"type": "array"},
            },
            "required": ["merchant_id", "weekly_hours"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=300,
        timeout_ms=1500,
        retries=1,
        side_effect=False,
        cost_class="db",
        fallback="none",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):  # noqa: ARG001
        merchant_id = str(args["merchant_id"])
        rows = await backend.hours([merchant_id])
        return {"merchant_id": merchant_id,
                "weekly_hours": [dict(row) for row in rows]}

    registry.register(spec, handler=handler)
    return spec


def register_read_tools(registry: Registry, backend: SearchBackend) -> Registry:
    build_get_business_hours(registry, backend)
    return registry
