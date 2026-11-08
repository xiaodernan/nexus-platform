"""The tool-dispatch registry — AGENT_CONTRACT §3.

The contract's rule, verbatim in intent: *tools are the only way an agent reaches data;
no direct SQL from agent code, no prompt→DB path. Side-effect tools require an explicit
user action + `Idempotency-Key`.*

This module implements that pipeline:

    subject -> dispatch(tool, args) -> permission check -> argument validation
    -> timeout/retry -> execute -> result validation -> audit/log -> return

Dispatch does not *provide* tools. `Registry.register(spec, handler)` attaches a real
handler to a declared ToolSpec; nothing is reachable that nobody implemented, and
`/ai/v1/tools` advertises the tools the process actually holds. A name the registry does
not know is a hard `UnknownTool` — never silently treated as a no-op, and never allowed to
invent a result.

The permission model encodes §4's grant kinds and the two tools that are **never** in a
default grant (§4):

* `PERMISSION_READ` — reading tools (search_*, get_*, retrieve_*, analyze_*, summarize_*, compare_entities),
* `PERMISSION_WRITE` — tools that write non-commerce state (record_event),
* `PERMISSION_SIDE_EFFECT` — tools that act on the world (create_*, update_cart, checkout,
  draft_campaign, draft_seo_page, set_user_preference), requiring an explicit user action
  (an idempotency key), and
* grant for the two never-in-default-grant names (`refund_payment`, `publish_campaign`)
  never comes from the default resolver — only from an explicit per-subject grant.

This registry does not *assume* a dispatcher somewhere would catch a caller's mistake.
A caller mistakes an argument name for an argument *value*; a tool name for content. Both
are refused outright.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Sequence

from nexus_ai.tools.names import CANONICAL_TOOL_NAMES, NEVER_IN_DEFAULT_GRANT


class _Cache:
    """In-process TTL cache keyed on spec name + canonicalised argument dict.

    Side-effect tools bypass it entirely; specs whose `cache_ttl_s` is 0 never enter it;
    args that cannot be JSON-canonically dumped never enter it either. The life of a hit
    is bounded by the spec's `cache_ttl_s`, never beyond.
    """

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._store: dict[tuple[str, str], tuple[float, Any]] = {}

    def _key(self, *, spec: ToolSpec, arguments: Mapping[str, Any]) -> tuple[str, str] | None:
        try:
            key = json.dumps(dict(arguments), sort_keys=True, separators=(",", ":"),
                             default=str)
        except (TypeError, ValueError):
            return None
        return (spec.name, key)

    def get(self, *, spec: ToolSpec, arguments: Mapping[str, Any]) -> Any:
        ck = self._key(spec=spec, arguments=arguments)
        if ck is None:
            return _MISS
        hit = self._store.get(ck)
        if hit is None:
            return _MISS
        expires_at, value = hit
        if self._clock() >= expires_at:
            del self._store[ck]
            return _MISS
        return value

    def set(self, *, spec: ToolSpec, arguments: Mapping[str, Any], value: Any) -> None:
        ck = self._key(spec=spec, arguments=arguments)
        if ck is None:
            return
        self._store[ck] = (self._clock() + spec.cache_ttl_s, value)


#: sentinel for "no cache hit" — identity-compared only, never leaked out.
_MISS = object()


# ------------------------------------------------------------ permission kinds
PERMISSION_READ = "tool:read"
PERMISSION_WRITE = "tool:write"
PERMISSION_SIDE_EFFECT = "tool:side_effect"
PERMISSION_KINDS = (PERMISSION_READ, PERMISSION_WRITE, PERMISSION_SIDE_EFFECT)

#: default grants for any subject: read-only. `record_event` needs an explicit write
#: grant; nothing side-effectful is ever defaulted.
DEFAULT_GRANTS = frozenset({PERMISSION_READ})

#: the canonical permission kind each canonical tool needs, keyed by tool name. Anything
#: not named here is unknown — the registry refuses it rather than assume a permission.
DEFAULT_PERMISSIONS: dict[str, str] = {
    "search_merchants": PERMISSION_READ,
    "search_products": PERMISSION_READ,
    "search_services": PERMISSION_READ,
    "search_reviews": PERMISSION_READ,
    "search_location": PERMISSION_READ,
    "get_business_hours": PERMISSION_READ,
    "get_price": PERMISSION_READ,
    "get_inventory": PERMISSION_READ,
    "get_availability": PERMISSION_READ,
    "create_reservation": PERMISSION_SIDE_EFFECT,
    "create_cart": PERMISSION_SIDE_EFFECT,
    "update_cart": PERMISSION_SIDE_EFFECT,
    "checkout": PERMISSION_SIDE_EFFECT,
    "get_order_status": PERMISSION_READ,
    "search_web": PERMISSION_READ,
    "retrieve_merchant_documents": PERMISSION_READ,
    "analyze_reviews": PERMISSION_READ,
    "get_user_preferences": PERMISSION_READ,
    "set_user_preference": PERMISSION_SIDE_EFFECT,
    "summarize_reviews": PERMISSION_READ,
    "compare_entities": PERMISSION_READ,
    "draft_campaign": PERMISSION_SIDE_EFFECT,
    "draft_seo_page": PERMISSION_SIDE_EFFECT,
    "record_event": PERMISSION_WRITE,
}

assert tuple(sorted(DEFAULT_PERMISSIONS)) == tuple(sorted(CANONICAL_TOOL_NAMES))

# ------------------------------------------------------------ errors
class ToolError(Exception):
    """Base — every dispatch failure carries a stable `.code` for the error envelope."""


class UnknownTool(ToolError):
    def __init__(self, tool: str) -> None:
        self.tool = tool
        self.code = "unknown_tool"
        super().__init__(f"{tool!r} is not a registered tool")


class InvalidArguments(ToolError):
    def __init__(self, tool: str, detail: str) -> None:
        self.tool = tool
        self.detail = detail
        self.code = "invalid_arguments"
        super().__init__(f"{tool!r}: {detail}")


class PermissionDenied(ToolError):
    def __init__(self, tool: str, detail: str) -> None:
        self.tool = tool
        self.detail = detail
        self.code = "permission_denied"
        super().__init__(f"{tool!r}: {detail}")


class ToolTimeout(ToolError):
    def __init__(self, tool: str, timeout_ms: int) -> None:
        self.tool = tool
        self.timeout_ms = timeout_ms
        self.code = "timeout"
        super().__init__(f"{tool!r}: exceeded {timeout_ms} ms")


class ToolExecutionFailed(ToolError):
    def __init__(self, tool: str, detail: str) -> None:
        self.tool = tool
        self.detail = detail
        self.code = "execution_failed"
        super().__init__(f"{tool!r}: {detail}")


class ResultValidationFailed(ToolError):
    def __init__(self, tool: str, detail: str) -> None:
        self.tool = tool
        self.detail = detail
        self.code = "result_validation_failed"
        super().__init__(f"{tool!r}: {detail}")


# ------------------------------------------------------------ schema validation
_TYPES: dict[str, type | tuple[type, ...]] = {
    "object": dict,
    "array": list,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "null": type(None),
}


def _validate(schema: Mapping[str, Any], value: Any, *, path: str) -> None:
    """JSON-Schema subset — enough for the registry's contract and honest about what
    it does not support. Anything unrecognised in the schema is ignored, never honoured."""
    if not isinstance(schema, Mapping):
        return
    field = schema.get("type")
    if field is not None:
        types = (_TYPES[field],) if isinstance(field, str) else tuple(
            _TYPES[t] for t in field)
        if not any(isinstance(value, t) for t in types):
            raise ValueError(f"{path}: expected {field}, got {type(value).__name__}")
    if value is None:
        return
    if isinstance(value, dict):
        raw_props = schema.get("properties")
        props: Mapping[str, Any] = raw_props if isinstance(raw_props, Mapping) else {}
        raw_required = schema.get("required")
        required: Sequence[str] = raw_required if isinstance(raw_required, Sequence) else ()
        for key in required:
            if key not in value:
                raise ValueError(f"{path}: missing required property {key!r}")
        extra_ok = bool(schema.get("additionalProperties", True))
        for key, item in value.items():
            if key in props:
                _validate(props[key], item, path=f"{path}.{key}")
            elif not extra_ok:
                raise ValueError(f"{path}: property {key!r} is not declared")
    if isinstance(value, list):
        item = schema.get("items")
        if isinstance(item, Mapping):
            for idx, element in enumerate(value):
                _validate(item, element, path=f"{path}[{idx}]")


def _check(schema: Mapping[str, Any] | None, value: Any) -> str | None:
    if not isinstance(schema, Mapping):
        return None
    try:
        _validate(schema, value, path="$")
        return None
    except ValueError as exc:
        return str(exc)


# ------------------------------------------------------------ the spec
@dataclass(frozen=True)
class ToolSpec:
    name: str
    version: str = "1"
    description: str = ""
    input_schema: Mapping[str, Any] = field(default_factory=dict)
    output_schema: Mapping[str, Any] = field(default_factory=dict)
    permission: str = PERMISSION_READ
    scopes: tuple[str, ...] = ()
    timeout_ms: int = 4000
    retries: int = 0
    cache_ttl_s: int = 0
    side_effect: bool = False
    cost_class: str = "db"  # one of db|vector|llm_cheap|llm_reason|external (§3)
    fallback: str = "none"


_HANDLER = Callable[..., Awaitable[Any]]  # public for docs only


# ------------------------------------------------------------ the registry
_COST_CLASSES = frozenset({"db", "vector", "llm_cheap", "llm_reason", "external"})

class Registry:
    """An agent reaches the world ONLY through here.

    `dispatch` implements §3's pipeline; `manifest` reports what the process actually
    holds. Registering is explicit: a `ToolSpec` is a declaration, a handler is an
    implementation, and the two arrive together or the tool stays declared-only.
    """

    def __init__(self, *, permissions: Callable[[str], set[str]] | None = None,
                 audit: Callable[[Mapping[str, Any]], None] | None = None,
                 clock: Callable[[], float] | None = None) -> None:
        #: §3: an agent's permission set is per subject, never per model.
        self._permissions = permissions or (lambda _subject: set(DEFAULT_GRANTS))
        self._audit = audit or (lambda _event: None)
        self._clock = clock or time.monotonic
        self._specs: dict[str, ToolSpec] = {}
        self._handlers: dict[str, _HANDLER] = {}
        self._cache = _Cache(self._clock)

    # ---------------------------------------------------- registration
    def register(self, spec: ToolSpec, handler: "_HANDLER | None" = None) -> None:
        if spec.name not in CANONICAL_TOOL_NAMES and spec.name not in NEVER_IN_DEFAULT_GRANT:
            raise ToolError(
                f"{spec.name!r} is neither a §3 canonical tool name nor a named "
                f"never-in-default-grant tool")
        if spec.cost_class not in _COST_CLASSES:
            raise ToolError(
                f"{spec.name!r}: cost_class {spec.cost_class!r} is not one of the "
                f"{sorted(_COST_CLASSES)} §3 names")
        if spec.timeout_ms <= 0:
            raise ToolError(f"{spec.name!r}: timeout_ms must be positive")
        if spec.retries < 0:
            raise ToolError(f"{spec.name!r}: retries must not be negative")
        if spec.cache_ttl_s < 0:
            raise ToolError(f"{spec.name!r}: cache_ttl_s must not be negative")
        if spec.permission not in PERMISSION_KINDS and not spec.permission.startswith("grant:"):
            raise ToolError(
                f"{spec.name!r}: permission {spec.permission!r} is neither a §3 grant kind "
                f"({PERMISSION_KINDS}) nor a per-subject grant (grant:<tool>)")
        self._specs[spec.name] = spec
        if handler is not None:
            self._handlers[spec.name] = handler

    def contains(self, name: str) -> bool:
        return name in self._specs

    def spec(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    # ---------------------------------------------------- manifest
    def manifest(self) -> list[ToolSpec]:
        return [self._specs[name] for name in tuple(CANONICAL_TOOL_NAMES)
                if name in self._specs]

    # ---------------------------------------------------- dispatch
    async def dispatch(self, *, subject: str, tool: str,
                       arguments: Mapping[str, Any] | None = None,
                       idempotency_key: str | None = None) -> Any:
        started = self._clock()
        args = dict(arguments or {})

        spec = self._specs.get(tool)
        if spec is None:
            self._emit(started, subject=subject, tool=tool,
                                 outcome="denied", reason="unknown_tool")
            raise UnknownTool(tool)

        # ---- permission check (§4) ----
        grants = set(self._permissions(subject))
        if tool in NEVER_IN_DEFAULT_GRANT and f"grant:{tool}" not in grants:
            # never in a default grant — an explicit per-subject grant is required
            self._emit(started, subject=subject, tool=tool,
                       outcome="denied", reason="never_in_default_grant")
            raise PermissionDenied(tool, "this tool is never in a default grant")
        if spec.permission not in grants:
            self._emit(started, subject=subject, tool=tool,
                       outcome="denied", reason="permission_denied")
            raise PermissionDenied(tool, f"missing grant {spec.permission!r}")
        if spec.side_effect and not idempotency_key:
            self._emit(started, subject=subject, tool=tool,
                       outcome="denied", reason="no_idempotency_key")
            raise PermissionDenied(tool, "side-effect tools need an explicit user action")

        # ---- argument validation ----
        schema_err = _check(spec.input_schema, args)
        if schema_err is not None:
            self._emit(started, subject=subject, tool=tool,
                       outcome="denied", reason=f"invalid_arguments: {schema_err}")
            raise InvalidArguments(tool, schema_err)

        # ---- cache (hit) ----
        use_cache = spec.cache_ttl_s > 0 and not spec.side_effect
        if use_cache:
            cached = self._cache.get(spec=spec, arguments=args)
            if cached is not _MISS:
                self._emit(started, subject=subject, tool=tool,
                           outcome="ok_cached")
                return cached


        # ---- execute with timeout/retry (§3 timeout is per-tool, default 4 s)
        handler = self._handlers.get(tool)
        if handler is None:
            self._emit(started, subject=subject, tool=tool,
                       outcome="failed", reason="no handler registered")
            raise ToolExecutionFailed(tool, "no handler is registered for this tool")
        last_error: BaseException | None = None
        attempts = max(1, spec.retries + 1)
        for attempt in range(1, attempts + 1):
            try:
                result = await asyncio.wait_for(handler(args, subject=subject),
                                                timeout=spec.timeout_ms / 1000)
                break
            except asyncio.TimeoutError:
                last_error = ToolTimeout(tool, spec.timeout_ms)
            except ToolError:
                raise
            except BaseException as exc:  # a tool raised — do not leak its details (§8)
                last_error = ToolExecutionFailed(tool, f"{exc.__class__.__name__}")
        else:
            self._emit(started, subject=subject, tool=tool, outcome="failed",
                       reason="retries exhausted")
            assert last_error is not None
            raise last_error  # type: ignore[misc]

        # ---- result validation ----
        result_err = _check(spec.output_schema, result)
        if result_err is not None:
            self._emit(started, subject=subject, tool=tool, result=result,
                       outcome="failed", reason=f"result_validation_failed: {result_err}")
            raise ResultValidationFailed(tool, result_err)

        if use_cache:
            self._cache.set(spec=spec, arguments=args, value=result)
        self._emit(started, subject=subject, tool=tool, result=result, outcome="ok")
        return result

    # ---------------------------------------------------- audit
    def _emit(self, started: float, *, subject: str, tool: str, outcome: str,
              reason: str | None = None, result: Any = None) -> dict[str, Any]:
        event: dict[str, Any] = {
            "tool": tool,
            "subject": subject,
            "outcome": outcome,
            "reason": reason,
            "duration_ms": int((self._clock() - started) * 1000),
        }
        self._audit(event)
        return event


__all__ = [
    "DEFAULT_GRANTS", "DEFAULT_PERMISSIONS",
    "PERMISSION_READ", "PERMISSION_WRITE", "PERMISSION_SIDE_EFFECT",
    "Registry", "ToolSpec",
    "ToolError", "UnknownTool", "InvalidArguments", "PermissionDenied",
    "ToolTimeout", "ToolExecutionFailed", "ResultValidationFailed",
]
