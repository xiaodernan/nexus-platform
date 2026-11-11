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


def build_get_price(registry: Registry, backend: SearchBackend) -> ToolSpec:
    """Register the `get_price` read tool against `backend`."""

    spec = ToolSpec(
        name="get_price",
        version="1",
        description=(
            "Read the honest price row for ONE subject (a merchant or an offering), "
            "through the facts table. Returns the price object exactly as the corpus "
            "writes it ({amount, currency, model?}); empty `price` when the corpus "
            "records none - never invents a price."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "subject_id": {"type": "string", "minLength": 1},
                "subject_type": {"type": "string", "enum": ["merchant", "offering"]},
            },
            "required": ["subject_id", "subject_type"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "subject_id": {"type": "string"},
                "subject_type": {"type": "string"},
                "price": {"type": "object"},
            },
            "required": ["subject_id", "subject_type", "price"],
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
        subject_id = str(args["subject_id"])
        subject_type = str(args["subject_type"])
        rows = await backend.facts([subject_id])
        for row in rows:
            if (str(row.get("attribute")) == "price"
                    and str(row.get("subject_type")) == subject_type):
                value = row.get("value")
                return {"subject_id": subject_id,
                        "subject_type": subject_type,
                        "price": dict(value) if isinstance(value, Mapping) else {}}
        return {"subject_id": subject_id, "subject_type": subject_type, "price": {}}

    registry.register(spec, handler=handler)
    return spec


def build_get_user_preferences(
    registry: Registry, backend: SearchBackend
) -> ToolSpec:
    """Register the `get_user_preferences` read tool against `backend`."""

    spec = ToolSpec(
        name="get_user_preferences",
        version="1",
        description=(
            "Read the caller's stored long-term and (optional) conversation-bound "
            "preferences. The handler reads ONLY the caller's own rows — it ignores any "
            "`user_id` that might arrive in the input envelope — and returns [] for "
            "users with nothing stored, or off-line where the demo catalogue answers "
            "with no preference rows."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "kinds": {"type": "array", "items": {"type": "string"}},
                "conversation_id": {"type": "string", "minLength": 1},
            },
        },
        output_schema={
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "preferences": {"type": "array"},
            },
            "required": ["user_id", "preferences"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=0,
        timeout_ms=1500,
        retries=0,
        side_effect=False,
        cost_class="db",
        fallback="none",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):
        if not isinstance(subject, str) or not subject:
            return {"user_id": "", "preferences": []}
        rows = await backend.user_preferences(
            subject,
            kinds=args.get("kinds"),
            conversation_id=(args.get("conversation_id")
                             if isinstance(args.get("conversation_id"), str) else None),
        )
        return {"user_id": subject,
                "preferences": [dict(row) for row in rows]}

    registry.register(spec, handler=handler)
    return spec


def build_search_reviews(
    registry: Registry,
    backend: SearchBackend,
    tenant_id: str | None = None,
) -> ToolSpec:
    """Read the published reviews for ONE merchant, through the merchant's own reviews rows."""

    del tenant_id  # accepted for signature symmetry with the search tools; unused

    spec = ToolSpec(
        name="search_reviews",
        version="1",
        description=(
            "Read the PUBLISHED reviews for ONE merchant. Returns review rows exactly as the "
            "corpus writes them (rating, title, body, created_at, verified_purchase, "
            "helpful_count). Never invents a review; a merchant with none answers with []."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "merchant_id": {"type": "string", "minLength": 1},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "required": ["merchant_id"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "merchant_id": {"type": "string"},
                "reviews": {"type": "array"},
                "total": {"type": "integer"},
            },
            "required": ["merchant_id", "reviews", "total"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=300,
        timeout_ms=2000,
        retries=0,
        side_effect=False,
        cost_class="db",
        fallback="none",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):  # noqa: ARG001
        merchant_id = str(args["merchant_id"])
        limit = int(args.get("limit") or 20)
        rows = await backend.reviews([merchant_id], per_merchant=limit)
        return {"merchant_id": merchant_id,
                "reviews": [dict(row) for row in rows],
                "total": len(rows)}

    registry.register(spec, handler=handler)
    return spec


def build_search_merchants(
    registry: Registry,
    backend: SearchBackend,
    tenant_id: str | None = None,
) -> ToolSpec:
    """Register the `search_merchants` read tool against `backend`."""

    from nexus_ai.search.service import DEFAULT_TENANT_ID

    tenant = str(tenant_id or DEFAULT_TENANT_ID)

    spec = ToolSpec(
        name="search_merchants",
        version="1",
        description=(
            "Search the merchant plane the same way /ai/v1/search does, with a strict "
            "bounded envelope. Returns candidate merchant rows; never fabricates rows "
            "or attribute values."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "text": {"type": "string"},
                "category": {"type": "string"},
                "district": {"type": "string"},
                "open_now": {"type": "boolean"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
        },
        output_schema={
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "merchants": {"type": "array"},
                "total": {"type": "integer"},
            },
            "required": ["merchants"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=0,
        timeout_ms=3000,
        retries=0,
        side_effect=False,
        cost_class="db",
        fallback="none",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):  # noqa: ARG001
        text = args.get("text") or None
        filters: dict[str, Any] = {}
        if args.get("category"):
            filters["category"] = str(args["category"])
        if args.get("district"):
            filters["district"] = str(args["district"])
        if args.get("open_now"):
            filters["open_now"] = True
        rows = await backend.merchant_candidates(
            tenant_id=tenant,
            text=text,
            filters=filters or None,
            limit=int(args.get("limit") or 20),
            with_total=True,
        )
        return {"text": args.get("text") or "",
                "merchants": [dict(row) for row in rows]}

    registry.register(spec, handler=handler)
    return spec


def build_search_offering(
    registry: Registry,
    backend: SearchBackend,
    tenant_id: str | None = None,
    *,
    kind: str,
) -> ToolSpec:
    """Register a `search_products` / `search_services` tool against `backend`."""
    from nexus_ai.search.service import DEFAULT_TENANT_ID

    tenant = str(tenant_id or DEFAULT_TENANT_ID)

    name = f"search_{kind}s"

    spec = ToolSpec(
        name=name,
        version="1",
        description=(
            f"Search the offerings plane filtered to kind={kind!r}. Bounded, "
            f"server-side tenant-scoped, never fabricated."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "text": {"type": "string"},
                "category": {"type": "string"},
                "district": {"type": "string"},
                "party_size": {"type": "integer", "minimum": 1, "maximum": 50},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
        },
        output_schema={
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "offerings": {"type": "array"},
            },
            "required": ["offerings"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=0,
        timeout_ms=3000,
        retries=0,
        side_effect=False,
        cost_class="db",
        fallback="none",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):  # noqa: ARG001
        filters: dict[str, Any] = {"kind": kind}
        if args.get("category"):
            filters["category"] = str(args["category"])
        if args.get("district"):
            filters["district"] = str(args["district"])
        rows = await backend.offering_candidates(
            tenant_id=tenant,
            text=args.get("text") or None,
            filters=filters,
            party_size=(args.get("party_size")
                        if isinstance(args.get("party_size"), int) else None),
            limit=int(args.get("limit") or 20),
            with_total=True,
        )
        return {"text": args.get("text") or "",
                "offerings": [dict(row) for row in rows]}

    registry.register(spec, handler=handler)
    return spec


def register_read_tools(
    registry: Registry,
    backend: SearchBackend,
    tenant_id: str | None = None,
) -> Registry:
    build_get_business_hours(registry, backend)
    build_get_price(registry, backend)
    build_get_user_preferences(registry, backend)
    build_search_merchants(registry, backend, tenant_id)
    build_search_offering(registry, backend, tenant_id, kind="product")
    build_search_offering(registry, backend, tenant_id, kind="service")
    build_search_reviews(registry, backend, tenant_id)
    return registry
