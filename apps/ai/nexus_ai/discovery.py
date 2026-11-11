"""Sprint-cloud-style service registration for the AI service — opt-in, D856.

The Python half of the discovery lane. The monolith registers with Eureka only under its
`cloud` profile (D849, `dev,cloud` in services/platform); this module is the AI service's
answer to the same question. Registration is OFF by default — the single-process boot is
the product today, and a registry call on every startup is a change nobody asked for.

Opt-in: `NEXUS_AI_EUREKA_ENABLED=true` plus (optionally) `NEXUS_EUREKA_URI`
(default `http://127.0.0.1:18761/eureka/` — the D847 measured-free block, never the foreign
8761), `NEXUS_EUREKA_HOST` (default `127.0.0.1`), `NEXUS_AI_APP_NAME` (default `NEXUS-AI`),
`NEXUS_AI_HOST_PORT` (the port start_ai.py binds; default `8010`).

The service registers to be FOUND; it fetches nothing (`should_discover=False`), the same
shape as the monolith's cloud profile. Leases are 5s/10s so a killed instance leaves the
registry quickly instead of serving zombies. If registration fails the app logs a warning
and keeps serving — the registry is not a startup dependency (D4: misconfiguration degrades,
never crashes).

The py-eureka-client's own daemon heartbeat thread did not keep the lease alive on this
stack (registration at boot worked, renewals stopped after the first interval), so the
heartbeat here is ours: an asyncio task renews the lease every 5 seconds for as long as
the app serves, and a cancellation on shutdown stops it.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import suppress

log = logging.getLogger("nexus_ai.discovery")

_HEARTBEAT_INTERVAL_S = 5.0
# D965 — de-registration is an `await`ed network call (EurekaClient.stop() sends a DOWN
# register then a DELETE). It MUST be awaited or the coroutine never runs and the dead
# replica stays in the registry until its 10s lease expires; but shutdown must never hang
# on a registry that is itself down, so bound it. The lease self-expires either way.
_DEREGISTER_TIMEOUT_S = 2.0


def eureka_enabled() -> bool:
    return os.environ.get("NEXUS_AI_EUREKA_ENABLED", "").strip().lower() in {"true", "1", "yes"}


class Registration:
    """An opted-in Eureka registration and the heartbeat that keeps it."""

    def __init__(self, client) -> None:
        self.client = client
        self._task: asyncio.Task | None = None

    async def start(self) -> "Registration":
        async def beat() -> None:
            while True:
                await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
                try:
                    await self.client.send_heartbeat()
                except Exception as exc:  # a stale lease is worse than a noisy log — keep trying
                    log.warning("eureka heartbeat failed, will retry: %s", exc)

        self._task = asyncio.create_task(beat(), name="nexus-eureka-heartbeat")
        return self

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        try:
            # D965 — EurekaClient.stop() is `async def`: a bare call only CREATES the
            # coroutine and never schedules it, so the DOWN register + DELETE never leave
            # the process (and Python logs "coroutine was never awaited"). Await it so the
            # de-registration actually happens, but under a timeout so a down registry
            # cannot hang shutdown — the 10s lease self-expires if this times out or fails.
            await asyncio.wait_for(self.client.stop(), timeout=_DEREGISTER_TIMEOUT_S)
        except Exception:  # the lease expires on its own; shutdown must never hang on it
            log.warning("eureka de-registration failed — lease will expire on its own", exc_info=True)


async def maybe_register_eureka() -> Registration | None:
    """Register NEXUS-AI with Eureka when the env opts in; returns a Registration or None.

    Never raises. A failed registration is a warning in the logs and a still-running
    service, not a boot failure."""
    if not eureka_enabled():
        return None
    from py_eureka_client import eureka_client as ec  # type: ignore[import-untyped]

    server = os.environ.get("NEXUS_EUREKA_URI", "http://127.0.0.1:18761/eureka/")
    host = os.environ.get("NEXUS_EUREKA_HOST", "127.0.0.1")
    # start_ai.py binds NEXUS_AI_HOST_PORT (default 8010); register THAT port, not a drift copy.
    port = int(os.environ.get("NEXUS_AI_HOST_PORT", os.environ.get("NEXUS_AI_PORT", "8010")))
    name = os.environ.get("NEXUS_AI_APP_NAME", "NEXUS-AI")
    try:
        client = await ec.init_async(
            eureka_server=server,
            app_name=name,
            instance_port=port,
            instance_host=host,
            instance_ip=host,
            instance_id=f"{name}:{port}",
            renewal_interval_in_secs=5,
            duration_in_secs=10,
            should_register=True,
            should_discover=False,  # findable, not a client — same shape as the monolith's cloud profile
            health_check_url="/actuator/health",  # D877: what the Spring Boot Admin probes (default would be /health)
            status_page_url="/actuator/info",
            home_page_url="/actuator",
            metadata={"management.port": str(port)},  # the admin's discovery default reads this too
        )
    except Exception:
        log.warning("eureka registration failed — serving without a registry (D4)", exc_info=True)
        return None
    log.info("registered with eureka as %s on %s:%d (opt-in)", name, host, port)
    print(f"[discovery] registered with eureka as {name} on {host}:{port}", flush=True)
    return await Registration(client).start()


async def stop_eureka(registration: Registration | None) -> None:
    """Stop the heartbeat and de-register; never raises."""
    if registration is None:
        return
    await registration.stop()
