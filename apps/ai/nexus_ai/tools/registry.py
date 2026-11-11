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
import heapq
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Sequence

from nexus_ai.tools.redis_tier import RedisTier

from nexus_ai.tools.names import CANONICAL_TOOL_NAMES, NEVER_IN_DEFAULT_GRANT


class _Cache:
    """In-process TTL cache keyed on spec name + canonicalised argument dict.

    Side-effect tools bypass it entirely; specs whose `cache_ttl_s` is 0 never enter it;
    args that cannot be JSON-canonically dumped never enter it either. The life of a hit
    is bounded by the spec's `cache_ttl_s`, never beyond.

    D903: the store is a bounded LRU (`OrderedDict`, O(1) recency + eviction), not an
    unbounded dict. Without a cap a long-lived process retained one entry per distinct
    argument dict forever; TTL was checked only on read, so expired entries lingered
    until something happened to read them. A write now reclaims expired entries and
    evicts the least-recently-used once `max_entries` is reached, so both memory and the
    sweep cost are bounded by the cap rather than by the number of distinct args seen.
    """

    def __init__(self, clock: Callable[[], float], max_entries: int = 4096) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self._clock = clock
        self._max = max_entries
        self._store: OrderedDict[tuple[str, str], tuple[float, Any]] = OrderedDict()
        # D913: an expiry min-heap. Each entry is pushed exactly once, popped exactly once, so
        # the heap operations are amortized O(log n) per write and O(1) per read. Lazy: stale
        # (overwritten or delete-swept) heap entries are tolerated and detected on pop by checking
        # the store still holds that exact (key, expires_at) pair.
        self._expiry_heap: list[tuple[float, tuple[str, str]]] = []

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
        self._store.move_to_end(ck)
        return value

    def _sweep_expired(self, now: float) -> None:
        while self._expiry_heap and self._expiry_heap[0][0] <= now:
            expires_at, ck = heapq.heappop(self._expiry_heap)
            entry = self._store.get(ck)
            # discard stale heap entries — the store moved on, the key was overwritten,
            # or it was already swept by this loop
            if entry is not None and entry[0] == expires_at:
                del self._store[ck]

    def set(self, *, spec: ToolSpec, arguments: Mapping[str, Any], value: Any) -> None:
        ck = self._key(spec=spec, arguments=arguments)
        if ck is None:
            return
        now = self._clock()
        self._sweep_expired(now)
        expires = now + spec.cache_ttl_s
        self._store[ck] = (expires, value)
        heapq.heappush(self._expiry_heap, (expires, ck))
        self._store.move_to_end(ck)
        while len(self._store) > self._max:
            self._store.popitem(last=False)


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
def _is_integer(value: Any) -> bool:
    # JSON Schema treats true/false as a distinct primitive from numbers.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)) or isinstance(value, float)


_TYPES: dict[str, Callable[[Any], bool]] = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "number": lambda value: _is_number(value),
    "integer": lambda value: _is_integer(value),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
}


def _validate(schema: Mapping[str, Any], value: Any, *, path: str) -> None:
    """JSON-Schema subset — enough for the registry's contract and honest about what
    it does not support. Anything unrecognised in the schema is ignored, never honoured."""
    if not isinstance(schema, Mapping):
        return
    field = schema.get("type")
    if field is not None:
        if isinstance(field, str):
            fields = (field,)
        else:
            fields = tuple(field)  # e.g. ["string", "null"]
        preds = [_TYPES[name] for name in fields if name in _TYPES]
        if preds and not any(predicate(value) for predicate in preds):
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
    raw_enum = schema.get("enum")
    if isinstance(raw_enum, Sequence) and value not in raw_enum:
        raise ValueError(f"{path}: value {value!r} is not one of the allowed enum values")
    if isinstance(value, str):
        min_len = schema.get("minLength")
        if isinstance(min_len, int) and len(value) < min_len:
            raise ValueError(f"{path}: shorter than minLength {min_len}")
        max_len = schema.get("maxLength")
        if isinstance(max_len, int) and len(value) > max_len:
            raise ValueError(f"{path}: longer than maxLength {max_len}")
    if _is_number(value):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            raise ValueError(f"{path}: below minimum {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            raise ValueError(f"{path}: above maximum {maximum}")
    if isinstance(value, list):
        items = value
        item = schema.get("items")
        if isinstance(item, Mapping):
            for idx, element in enumerate(items):
                _validate(item, element, path=f"{path}[{idx}]")
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(items) < min_items:
            raise ValueError(f"{path}: fewer than minItems {min_items}")
        max_items = schema.get("maxItems")
        if isinstance(max_items, int) and len(items) > max_items:
            raise ValueError(f"{path}: more than maxItems {max_items}")


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
        # D922 — opt-in shared tier (Redis). Absent by default: no client constructed,
        # behaviour byte-identical to the local-only lane. When explicitly requested via
        # NEXUS_AI_SHARED_CACHE=redis, the tier reads/writes the same canonical key and TTL
        # discipline so a replica layer sees one cache instead of N.
        self._shared = RedisTier.maybe_create()

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
            if self._shared is not None:
                shared_key = self._cache._key(spec=spec, arguments=args)
                if shared_key is not None:
                    raw = self._shared.get(shared_key[0], shared_key[1])
                    if raw is not None:
                        self._emit(started, subject=subject, tool=tool,
                                   outcome="ok_cached_shared")
                        self._cache.set(spec=spec, arguments=args, value=raw)
                        return raw


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
            if self._shared is not None:
                shared_key = self._cache._key(spec=spec, arguments=args)
                if shared_key is not None:
                    self._shared.set(shared_key[0], shared_key[1], result, spec.cache_ttl_s)
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
