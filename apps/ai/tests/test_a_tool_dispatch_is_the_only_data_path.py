"""D772 - the tool dispatch registry exists and enforces the contract's rules.

AGENT_CONTRACT §3/§4: every agent reaches data through the registry; no direct SQL from
agent code; no prompt→DB path; side-effect tools require an explicit user action +
`Idempotency-Key`; `refund_payment` and `publish_campaign` are never in a default grant.

This gate pins the module the HTTP layer advertises as absent: `tools/registry.py` — a
`Registry`, a `ToolSpec`, and a dispatch pipeline: permission check → argument validation
→ timeout/retry → execute → result validation → audit/log. The manifest reports what the
process actually holds; a tool nobody implemented is a hard `UnknownTool`, never a
silent nothing.
"""

from __future__ import annotations

import asyncio

import pytest

from nexus_ai.tools.names import CANONICAL_TOOL_NAMES, NEVER_IN_DEFAULT_GRANT
from nexus_ai.tools.registry import (
    PERMISSION_READ,
    PERMISSION_SIDE_EFFECT,
    PERMISSION_WRITE,
    InvalidArguments,
    PermissionDenied,
    Registry,
    ToolExecutionFailed,
    ToolSpec,
    ToolTimeout,
    UnknownTool,
)


def _spec(name, **over):
    base = dict(name=name, description=f"test spec for {name}",
                input_schema={"type": "object", "additionalProperties": False,
                              "properties": {"query": {"type": "string"}},
                              "required": ["query"]},
                output_schema={"type": "object", "properties": {"rows": {"type": "array"}}},
                permission=PERMISSION_READ, timeout_ms=1000, retries=0)
    base.update(over)
    return ToolSpec(**base)


def _registry(**kw):
    events: list[dict] = []
    reg = Registry(audit=lambda e: events.append(e), **kw)
    return reg, events


class TestDispatchUnknownTools:
    def test_unknown_tool_is_a_hard_error(self):
        reg, events = _registry()
        with pytest.raises(UnknownTool):
            asyncio.run(reg.dispatch(subject="u1", tool="no_such_tool", arguments={}))
        assert events[-1]["outcome"] == "denied"

    def test_unregistered_canonical_name_is_refused(self):
        """A name the contract knows but nobody implemented: still not fabricated."""
        reg, _ = _registry()
        for tool in sorted(CANONICAL_TOOL_NAMES):
            with pytest.raises(UnknownTool):
                asyncio.run(reg.dispatch(subject="u1", tool=tool, arguments={"query": "x"}))


class TestDispatchPermission:
    def test_missing_read_grant_refuses(self):
        reg, events = _registry(permissions=lambda _s: {PERMISSION_WRITE})
        spec = _spec("search_merchants")
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        with pytest.raises(PermissionDenied):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": "x"}))
        assert events[-1]["outcome"] == "denied"

    def test_side_effect_needs_a_user_action(self):
        reg, events = _registry(permissions=lambda _s: {PERMISSION_READ,
                                                        PERMISSION_SIDE_EFFECT})
        spec = _spec("create_reservation", permission=PERMISSION_SIDE_EFFECT,
                     side_effect=True)
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        with pytest.raises(PermissionDenied):
            asyncio.run(reg.dispatch(subject="u1", tool="create_reservation",
                                     arguments={"query": "x"}))
        assert events[-1]["reason"] == "no_idempotency_key"

    def test_side_effect_with_idempotency_key_passes(self):
        reg, _ = _registry(permissions=lambda _s: {PERMISSION_READ,
                                                   PERMISSION_SIDE_EFFECT})
        spec = _spec("create_reservation", permission=PERMISSION_SIDE_EFFECT,
                     side_effect=True)
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        out = asyncio.run(reg.dispatch(subject="u1", tool="create_reservation",
                                       arguments={"query": "x"},
                                       idempotency_key="idem-1"))
        assert out == {"rows": []}

    def test_never_in_default_grant_even_with_side_effect_grant(self):
        reg, events = _registry(permissions=lambda _s: {PERMISSION_READ, PERMISSION_SIDE_EFFECT})
        for name in NEVER_IN_DEFAULT_GRANT:
            spec = _spec(name, permission=PERMISSION_SIDE_EFFECT, side_effect=True)
            reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
            with pytest.raises(PermissionDenied):
                asyncio.run(reg.dispatch(subject="u1", tool=name,
                                         arguments={"query": "x"},
                                         idempotency_key="idem-2"))
        assert events[-1]["reason"] == "never_in_default_grant"

    def test_explicit_per_subject_grant_rescues_never_in_default_grant(self):
        reg, _ = _registry(permissions=lambda _s: {PERMISSION_READ, PERMISSION_SIDE_EFFECT,
                                                   "grant:refund_payment"})
        spec = _spec("refund_payment", permission="grant:refund_payment",
                     side_effect=True)
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        # spec.permission is the explicit-grant marker, so the default-check is bypassed
        out = asyncio.run(reg.dispatch(subject="u1", tool="refund_payment",
                                       arguments={"query": "x"},
                                       idempotency_key="idem-3"))
        assert out == {"rows": []}


class TestDispatchValidation:
    def test_missing_required_argument_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants")
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        with pytest.raises(InvalidArguments):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants", arguments={}))

    def test_extra_argument_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants")
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        with pytest.raises(InvalidArguments):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": "x", "extra": 1}))

    def test_wrong_type_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants")
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        with pytest.raises(InvalidArguments):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": 123}))


class TestDispatchExecution:
    def test_timeout_raises_ToolTimeout(self):
        async def slow(_args, *, subject):
            await asyncio.sleep(0.02)
            return {"rows": []}
        reg, events = _registry()
        spec = _spec("search_merchants", timeout_ms=5)
        reg.register(spec, handler=slow)
        with pytest.raises(ToolTimeout):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": "x"}))
        assert events[-1]["outcome"] == "failed"

    def test_retry_retries_then_succeeds(self):
        calls = {"n": 0}

        async def flaky(_args, *, subject):
            calls["n"] += 1
            if calls["n"] < 2:
                raise RuntimeError("transient")
            return {"rows": []}

        reg, _ = _registry()
        spec = _spec("search_merchants", retries=1)
        reg.register(spec, handler=flaky)
        out = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                       arguments={"query": "x"}))
        assert out == {"rows": []}
        assert calls["n"] == 2

    def test_retries_exhausted_raise_ToolExecutionFailed(self):
        async def always_fail(_args, *, subject):
            raise RuntimeError("permanent")
        reg, _ = _registry()
        spec = _spec("search_merchants", retries=0)
        reg.register(spec, handler=always_fail)
        with pytest.raises(ToolExecutionFailed):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": "x"}))

    def test_handler_raises_ToolError_unchanged(self):
        from nexus_ai.tools.registry import ToolExecutionFailed as _TEF

        async def co(_args, *, subject):
            raise _TEF("search_merchants", "upstream refused")
        reg, _ = _registry()
        spec = _spec("search_merchants", retries=3)  # a ToolError is not retried
        reg.register(spec, handler=co)
        with pytest.raises(_TEF):
            asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                     arguments={"query": "x"}))


class TestDispatchAudit:
    def test_every_outcome_is_audited(self):
        reg, events = _registry()
        # unknown tool -> audited as denied
        with pytest.raises(UnknownTool):
            asyncio.run(reg.dispatch(subject="u1", tool="no_such_tool", arguments={}))
        assert any(e["outcome"] == "denied" for e in events)

    def test_successful_call_is_audited_ok(self):
        reg, events = _registry()
        spec = _spec("search_merchants")
        reg.register(spec, handler=lambda args, *, subject: _fake(subject=subject))
        asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                arguments={"query": "x"}))
        assert events[-1]["outcome"] == "ok"
        assert events[-1]["tool"] == "search_merchants"


class TestTheManifest:
    def test_empty_registry_manifests_nothing(self):
        reg, _ = _registry()
        assert reg.manifest() == []

    def test_manifest_lists_exactly_what_is_registered(self):
        reg, _ = _registry()
        reg.register(_spec("search_merchants"), handler=lambda a, *, subject: _fake(subject=subject))
        reg.register(_spec("get_price"), handler=lambda a, *, subject: _fake(subject=subject))
        names = [s.name for s in reg.manifest()]
        assert names == [s.name for s in reg.manifest()]
        assert set(names) == {"search_merchants", "get_price"}


class TestSpecValidation:
    def test_unknown_cost_class_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants", cost_class="magic")
        with pytest.raises(Exception):
            reg.register(spec)

    def test_bad_timeout_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants", timeout_ms=0)
        with pytest.raises(Exception):
            reg.register(spec)

    def test_negative_retries_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants", retries=-1)
        with pytest.raises(Exception):
            reg.register(spec)

    def test_negative_cache_ttl_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants", cache_ttl_s=-1)
        with pytest.raises(Exception):
            reg.register(spec)

    def test_bad_permission_kind_refused(self):
        reg, _ = _registry()
        spec = _spec("search_merchants", permission="tool:admin")
        with pytest.raises(Exception):
            reg.register(spec)

    def test_per_subject_grant_marker_accepted(self):
        reg, _ = _registry()
        spec = _spec("refund_payment", permission="grant:refund_payment",
                     side_effect=True)
        reg.register(spec)


class TestCacheBehaviour:
    def test_cache_hit_never_calls_handler_twice(self):
        calls = {"n": 0}

        async def counted(_args, *, subject):
            calls["n"] += 1
            return {"rows": [str(calls["n"])]}

        reg, events = _registry()
        spec = _spec("search_merchants", cache_ttl_s=60)
        reg.register(spec, handler=counted)
        first = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                         arguments={"query": "x"}))
        second = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                          arguments={"query": "x"}))
        assert first == second
        assert calls["n"] == 1
        assert any(e["outcome"] == "ok_cached" for e in events)

    def test_different_args_are_different_hits(self):
        calls = {"n": 0}

        async def counted(_args, *, subject):
            calls["n"] += 1
            return {"rows": [str(calls["n"])]}

        reg, _ = _registry()
        spec = _spec("search_merchants", cache_ttl_s=60)
        reg.register(spec, handler=counted)
        asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                 arguments={"query": "x"}))
        asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                 arguments={"query": "y"}))
        assert calls["n"] == 2

    def test_side_effect_never_enters_cache(self):
        calls = {"n": 0}

        async def counted(_args, *, subject):
            calls["n"] += 1
            return {"rows": []}

        reg, _ = _registry(permissions=lambda _s: {PERMISSION_READ,
                                                   PERMISSION_SIDE_EFFECT})
        spec = _spec("create_reservation", permission=PERMISSION_SIDE_EFFECT,
                     side_effect=True, cache_ttl_s=60)
        reg.register(spec, handler=counted)
        for idem in ("i1", "i2"):
            asyncio.run(reg.dispatch(subject="u1", tool="create_reservation",
                                     arguments={"query": "q"},
                                     idempotency_key=idem))
        assert calls["n"] == 2

    def test_cache_expires_after_ttl(self):
        times = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 61.0, 61.0, 61.0, 61.0])

        def tick():
            return next(times)

        calls = {"n": 0}

        async def counted(_args, *, subject):
            calls["n"] += 1
            return {"rows": [str(calls["n"])]}

        reg = Registry(audit=lambda e: None, clock=tick)
        spec = _spec("search_merchants", cache_ttl_s=60)
        reg.register(spec, handler=counted)
        first = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                         arguments={"query": "x"}))
        second = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                          arguments={"query": "x"}))
        assert first == second
        assert calls["n"] == 1  # still cached (t = 0.0 < 60.0)
        third = asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                         arguments={"query": "x"}))
        assert third == {"rows": ["2"]}
        assert calls["n"] == 2  # TTL expired at t = 61.0

    def test_zero_ttl_never_caches(self):
        calls = {"n": 0}

        async def counted(_args, *, subject):
            calls["n"] += 1
            return {"rows": []}

        reg, _ = _registry()
        spec = _spec("search_merchants", cache_ttl_s=0)
        reg.register(spec, handler=counted)
        asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                 arguments={"query": "x"}))
        asyncio.run(reg.dispatch(subject="u1", tool="search_merchants",
                                 arguments={"query": "x"}))
        assert calls["n"] == 2


async def _fake(*, subject):
    return {"rows": []}
