"""D965 — Eureka de-registration on graceful shutdown must be AWAITED, and bounded.

`Registration.stop()` (nexus_ai/discovery.py) is the AI service's shutdown hook. Its client,
the object returned by `await py_eureka_client.eureka_client.init_async(...)`, has an
``async def stop()``: cancelling the py-eureka heartbeat AND sending the DOWN register +
DELETE are coroutine bodies that only RUN when awaited.

Before D965 the hook called ``self.client.stop()`` bare. Calling an ``async def`` does not
run it — it only creates a coroutine — so on a graceful shutdown the de-registration
DELETE was NEVER sent, the client's heartbeat timer was never cancelled, and Python exited
with ``RuntimeWarning: coroutine 'EurekaClient.stop' was never awaited``. The surrounding
``try/except Exception`` could not help: a bare async call raises nothing at the call site.
Under the opt-in registry plane (``NEXUS_AI_EUREKA_ENABLED``) a killed replica therefore
stayed listed in Eureka until its 10s lease self-expired.

D965 awaits it under a timeout: ``await asyncio.wait_for(self.client.stop(), timeout=...)``.
That both makes the de-registration actually happen AND keeps the documented "shutdown
must never hang on a down registry" contract. This test proves both halves on the REAL
``Registration.stop()`` with a controlled stub — no live Eureka, no network, no sleeping:

* positive: with the shipped await, a stub's ``async stop()`` runs and sets its flag.
* falsifier: flip ONE variable — replace ``asyncio.wait_for`` with a shim that drops the
  coroutine it is handed without running it (the pre-D965 bare-call shape). The flag stays
  clear and Python reports a never-awaited coroutine. If the positive arm were green for a
  reason other than the await (e.g. a stub whose stop() is not really async), this arm would
  stay green too and fail the unit.
* timeout: a stub whose ``stop()`` hangs forever cannot hang shutdown — the bounded wait
  returns and the de-registration failure is logged.
* heartbeat: cancelling our own renew task still happens (the await did not skip it).

The matching structural + wiring claims live in ``scripts/check_eureka_deregister.mjs``.
Nothing here claims a live Eureka DELETE was observed or that a FastAPI worker was shut
down; it judges the shutdown hook's behaviour with a stub only.
"""

from __future__ import annotations

import asyncio
import gc
import logging
import warnings

from nexus_ai import discovery
from nexus_ai.discovery import Registration


class StubClient:
    """A stand-in for the EurekaClient returned by init_async(); stop() is a real coroutine."""

    def __init__(self, *, hang: bool = False) -> None:
        self.de_registered = False
        self.heartbeats = 0
        self._hang = hang

    async def send_heartbeat(self) -> None:
        self.heartbeats += 1

    async def stop(self) -> None:
        if self._hang:
            await asyncio.sleep(3600)  # a registry that never answers
        self.de_registered = True


async def _stop_with(stub: StubClient) -> Registration:
    """Drive the REAL Registration.stop() through start() so the heartbeat task is live."""
    reg = await Registration(stub).start()
    await reg.stop()
    return reg


def test_graceful_stop_awaits_deregistration():
    """Positive: the shipped await actually runs the client's async stop()."""
    stub = StubClient()
    reg = asyncio.run(_stop_with(stub))
    assert stub.de_registered is True, (
        "EurekaClient.stop() coroutine was never awaited — the DOWN/DELETE was not sent"
    )
    assert reg._task is None, "the renew task must be cleared on shutdown"


def test_without_await_de_registration_is_silently_skipped(monkeypatch):
    """Falsifier: drop the coroutine instead of awaiting it (pre-D965 bare-call shape).

    One flipped variable: ``asyncio.wait_for`` is replaced by a shim that returns without
    running the coroutine it was handed. The product's ``await`` then applies to the shim's
    return value (None), and the client's stop() coroutine is abandoned — exactly what a
    bare ``self.client.stop()`` did. If the positive green came from anywhere but the await,
    this arm would stay green and the unit would fail.
    """

    async def drop(coro, *, timeout=None):  # noqa: ANN001 - mirrors wait_for's call shape
        del coro, timeout  # deliberately NEVER await or run it
        return None

    monkeypatch.setattr(discovery.asyncio, "wait_for", drop, raising=True)
    stub = StubClient()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        asyncio.run(_stop_with(stub))
        gc.collect()  # CPython refcounting may drop the abandoned coroutine immediately
    assert stub.de_registered is False, (
        "dropping the await did not skip de-registration — the positive arm is vacuous"
    )
    assert any("never awaited" in str(w.message) for w in caught), (
        "abandoning the coroutine should surface RuntimeWarning: never awaited"
    )


def test_hanging_registry_cannot_hang_shutdown(caplog):
    """The bounded half: a client.stop() that never answers must not hang shutdown."""
    stub = StubClient(hang=True)
    with caplog.at_level(logging.WARNING, logger="nexus_ai.discovery"):
        asyncio.run(_stop_with(stub))
    # The wait_for timeout fires; the hook swallows it and the lease self-expires.
    assert stub.de_registered is False, "a hanging stop() should be abandoned, not awaited forever"
    assert any("de-registration failed" in r.message for r in caplog.records), (
        "a timed-out de-registration must be logged, not silently swallowed"
    )


def test_shutdown_bound_is_configured():
    """The await is bounded by a positive timeout, so shutdown can never block forever."""
    assert isinstance(discovery._DEREGISTER_TIMEOUT_S, (int, float))
    assert 0 < discovery._DEREGISTER_TIMEOUT_S < 30
