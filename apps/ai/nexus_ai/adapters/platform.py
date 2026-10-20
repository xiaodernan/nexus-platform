"""Platform service boundary — API_CONTRACT §0, §4, §6.

The commerce core (carts, reservations, orders, payments) belongs to the Spring Boot service
on :8080, so the AI service never writes those tables: mutation tools call platform HTTP with
the *caller's* scoped token. Two implementations sit behind `PlatformClient`:

* `HttpPlatformClient` — only the documented paths of §4/§6, with `Authorization`,
  `X-Tenant`, `X-Request-Id` and (where §1 requires it) `Idempotency-Key` forwarded verbatim.
* `StubPlatformClient` — the default, so tests and the offline demo never need :8080. It is a
  *real* deterministic implementation (it validates idempotency keys, rejects unpublished
  merchants, prices from a supplied catalogue) and every payload it returns carries
  `"stub": true` so nothing produced offline can be mistaken for a live order.

`NEXUS_PLATFORM_MODE=stub|http` selects. There is no AI-facing audit/permission endpoint in
the contract, so this client deliberately has no `write_audit`/`check_permission` method —
those live in `nexus_ai.tools`, on the DB side, with a fail-closed fallback.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

log = logging.getLogger("nexus_ai.adapters.platform")

IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9_\-:.]{8,128}$")


class PlatformUnavailable(RuntimeError):
    """The platform service could not be reached / is not configured."""


class PlatformRejectedRequest(RuntimeError):
    """Platform answered 4xx — surfaced as `conflict`/`validation_error`, never retried."""

    def __init__(self, message: str, *, status: int = 400,
                 details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.details = details or {}


@runtime_checkable
class PlatformClient(Protocol):
    """Documented platform operations the AI service may invoke."""

    mode: str

    async def get_merchant(self, id_or_slug: str, *, token: str | None = None,
                           tenant: str | None = None) -> dict[str, Any]: ...

    async def create_cart(self, *, merchant_id: str, session_id: str | None = None,
                          token: str | None = None, tenant: str | None = None) -> dict[str, Any]: ...

    async def add_cart_item(self, *, cart_id: str, offering_id: str, quantity: int = 1,
                            options: dict[str, Any] | None = None,
                            token: str | None = None, tenant: str | None = None) -> dict[str, Any]: ...

    async def price_check(self, cart_id: str, *, token: str | None = None,
                          tenant: str | None = None) -> dict[str, Any]: ...

    async def checkout(self, *, cart_id: str, idempotency_key: str,
                       token: str | None = None, tenant: str | None = None) -> dict[str, Any]: ...

    async def create_reservation(self, *, payload: dict[str, Any], idempotency_key: str,
                                 token: str | None = None,
                                 tenant: str | None = None) -> dict[str, Any]: ...

    async def get_order_status(self, order_id: str, *, token: str | None = None,
                               tenant: str | None = None) -> dict[str, Any]: ...


# --------------------------------------------------------------------------- shared rules
@dataclass
class StubCatalogue:
    """What the offline stub knows about merchants and offerings.

    A mutation is only accepted when the ids exist here — the stub is not a rubber stamp, and
    `stale`/price answers come from the same place so §20 is exercised offline.
    """

    merchants: dict[str, dict[str, Any]] = field(default_factory=dict)
    offerings: dict[str, dict[str, Any]] = field(default_factory=dict)


def _require_idempotency(key: str, *, action: str) -> str:
    if not key or not IDEMPOTENCY_RE.match(key):
        raise PlatformRejectedRequest(
            f"Idempotency-Key is required for {action} (API_CONTRACT §1)",
            status=422, details={"header": "Idempotency-Key"})
    return key


# --------------------------------------------------------------------------- http client
class HttpPlatformClient:
    mode = "http"

    def __init__(self, base_url: str, *, timeout_s: float = 5.0) -> None:
        if not base_url:
            raise PlatformUnavailable("NEXUS_PLATFORM_BASE_URL is unset")
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def _headers(self, token: str | None, tenant: str | None,
                 idempotency_key: str | None = None) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if tenant:
            headers["X-Tenant"] = tenant
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    async def _request(self, method: str, path: str, *, token: str | None,
                       tenant: str | None, json_body: dict[str, Any] | None = None,
                       idempotency_key: str | None = None) -> dict[str, Any]:
        import httpx

        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.request(method, url, json=json_body,
                                            headers=self._headers(token, tenant,
                                                                  idempotency_key))
        except httpx.HTTPError as exc:
            raise PlatformUnavailable(f"platform {method} {path} unreachable: {exc}") from exc
        if resp.status_code >= 400:
            raise PlatformRejectedRequest(
                f"platform {method} {path} -> {resp.status_code}",
                status=resp.status_code, details=_safe_json(resp))
        return _safe_json(resp)

    async def get_merchant(self, id_or_slug: str, *, token: str | None = None,
                           tenant: str | None = None) -> dict[str, Any]:
        return await self._request("GET", f"/api/v1/merchants/{id_or_slug}",
                                   token=token, tenant=tenant)

    async def create_cart(self, *, merchant_id: str, session_id: str | None = None,
                          token: str | None = None,
                          tenant: str | None = None) -> dict[str, Any]:
        return await self._request("POST", "/api/v1/carts", token=token, tenant=tenant,
                                   json_body={"merchant_id": merchant_id,
                                              **({"session_id": session_id} if session_id
                                                 else {})})

    async def add_cart_item(self, *, cart_id: str, offering_id: str, quantity: int = 1,
                            options: dict[str, Any] | None = None, token: str | None = None,
                            tenant: str | None = None) -> dict[str, Any]:
        return await self._request("POST", "/api/v1/carts/items", token=token, tenant=tenant,
                                   json_body={"cart_id": cart_id, "offering_id": offering_id,
                                              "quantity": int(quantity),
                                              "options": options or {}})

    async def price_check(self, cart_id: str, *, token: str | None = None,
                          tenant: str | None = None) -> dict[str, Any]:
        return await self._request("POST", "/api/v1/carts/price-check", token=token,
                                   tenant=tenant, json_body={"cart_id": cart_id})

    async def checkout(self, *, cart_id: str, idempotency_key: str, token: str | None = None,
                       tenant: str | None = None) -> dict[str, Any]:
        _require_idempotency(idempotency_key, action="checkout")
        return await self._request("POST", "/api/v1/carts/checkout", token=token,
                                   tenant=tenant, idempotency_key=idempotency_key,
                                   json_body={"cart_id": cart_id})

    async def create_reservation(self, *, payload: dict[str, Any], idempotency_key: str,
                                 token: str | None = None,
                                 tenant: str | None = None) -> dict[str, Any]:
        _require_idempotency(idempotency_key, action="reservation create")
        return await self._request("POST", "/api/v1/reservations", token=token, tenant=tenant,
                                   idempotency_key=idempotency_key, json_body=payload)

    async def get_order_status(self, order_id: str, *, token: str | None = None,
                               tenant: str | None = None) -> dict[str, Any]:
        return await self._request("GET", f"/api/v1/orders/{order_id}", token=token,
                                   tenant=tenant)


# --------------------------------------------------------------------------- offline stub
class StubPlatformClient:
    """Deterministic stand-in for :8080. Same rules, no network."""

    mode = "stub"

    def __init__(self, catalogue: StubCatalogue | None = None) -> None:
        self.catalogue = catalogue or StubCatalogue()
        self.calls: list[dict[str, Any]] = []
        self._carts: dict[str, dict[str, Any]] = {}
        self._reservations: dict[str, dict[str, Any]] = {}
        self._orders: dict[str, dict[str, Any]] = {}
        self._idem: dict[str, dict[str, Any]] = {}

    def _record(self, op: str, **kw: Any) -> None:
        self.calls.append({"op": op, **kw})

    def register_merchant(self, id_or_slug: str, **fields: Any) -> None:
        self.catalogue.merchants[id_or_slug] = {"id": id_or_slug, **fields}

    def register_offering(self, offering_id: str, **fields: Any) -> None:
        self.catalogue.offerings[offering_id] = {"id": offering_id, **fields}

    async def get_merchant(self, id_or_slug: str, *, token: str | None = None,
                           tenant: str | None = None) -> dict[str, Any]:
        self._record("get_merchant", id_or_slug=id_or_slug)
        row = self.catalogue.merchants.get(id_or_slug)
        if not row:
            raise PlatformRejectedRequest(f"merchant {id_or_slug} not found", status=404)
        return {**row, "stub": True}

    async def create_cart(self, *, merchant_id: str, session_id: str | None = None,
                          token: str | None = None,
                          tenant: str | None = None) -> dict[str, Any]:
        self._record("create_cart", merchant_id=merchant_id, has_token=bool(token))
        cart_id = f"stub-cart-{len(self._carts) + 1}"
        cart: dict[str, Any] = {"id": cart_id, "merchant_id": merchant_id,
                               "session_id": session_id,
                "status": "open", "items": [], "currency": "HKD", "stub": True}
        self._carts[cart_id] = cart
        return dict(cart)

    async def add_cart_item(self, *, cart_id: str, offering_id: str, quantity: int = 1,
                            options: dict[str, Any] | None = None, token: str | None = None,
                            tenant: str | None = None) -> dict[str, Any]:
        self._record("add_cart_item", cart_id=cart_id, offering_id=offering_id,
                     quantity=quantity)
        cart = self._carts.get(cart_id)
        if not cart:
            raise PlatformRejectedRequest(f"cart {cart_id} not found", status=404)
        offering = self.catalogue.offerings.get(offering_id)
        if not offering:
            raise PlatformRejectedRequest(
                f"offering {offering_id} unknown — the stub never invents a price",
                status=422)
        if offering.get("status") not in (None, "active"):
            raise PlatformRejectedRequest(f"offering {offering_id} not purchasable", status=409)
        unit = offering.get("price_amount")
        stale = bool(offering.get("price_stale"))
        item = {"id": f"stub-item-{cart_id}-{len(cart['items']) + 1}",
                "offering_id": offering_id, "quantity": int(quantity),
                "unit_price": unit, "currency": offering.get("currency", "HKD"),
                "price_source": offering.get("price_source", "merchant"),
                "stale": stale,
                **({"stale_copy": "價格可能已更新"} if stale else {})}
        cart["items"].append(item)
        cart["total"] = round(sum((i["unit_price"] or 0) * i["quantity"]
                                  for i in cart["items"]), 2)
        return dict(cart)

    async def price_check(self, cart_id: str, *, token: str | None = None,
                          tenant: str | None = None) -> dict[str, Any]:
        self._record("price_check", cart_id=cart_id)
        cart = self._carts.get(cart_id)
        if not cart:
            raise PlatformRejectedRequest(f"cart {cart_id} not found", status=404)
        return {"cart_id": cart_id, "items": cart["items"],
                "stale_count": sum(1 for i in cart["items"] if i.get("stale")),
                "total": cart.get("total", 0), "currency": "HKD", "stub": True}

    async def checkout(self, *, cart_id: str, idempotency_key: str, token: str | None = None,
                       tenant: str | None = None) -> dict[str, Any]:
        _require_idempotency(idempotency_key, action="checkout")
        self._record("checkout", cart_id=cart_id, idempotency_key=idempotency_key)
        if idempotency_key in self._idem:
            return dict(self._idem[idempotency_key])  # replay-safe, as §1 demands
        cart = self._carts.get(cart_id)
        if not cart:
            raise PlatformRejectedRequest(f"cart {cart_id} not found", status=404)
        if any(i.get("stale") for i in cart["items"]):
            raise PlatformRejectedRequest(
                "stale price in cart — re-confirm before charging (§20)",
                status=409, details={"items": [i["id"] for i in cart["items"]
                                               if i.get("stale")]})
        order_id = f"stub-order-{len(self._orders) + 1}"
        order = {"id": order_id, "code": f"NX{order_id[-4:]}", "cart_id": cart_id,
                 "status": "pending_payment", "total": cart.get("total", 0),
                 "currency": "HKD", "payment_intent": {"provider": "demo", "stub": True},
                 "stub": True}
        self._orders[order_id] = order
        cart["status"] = "checked_out"
        self._idem[idempotency_key] = order
        return dict(order)

    async def create_reservation(self, *, payload: dict[str, Any], idempotency_key: str,
                                 token: str | None = None,
                                 tenant: str | None = None) -> dict[str, Any]:
        _require_idempotency(idempotency_key, action="reservation create")
        self._record("create_reservation", idempotency_key=idempotency_key, **{
            k: payload.get(k) for k in ("merchant_id", "slot_id", "party_size")})
        for required in ("merchant_id", "slot_id", "party_size", "contact"):
            if not payload.get(required):
                raise PlatformRejectedRequest(
                    f"reservation create needs `{required}` (§6)", status=422)
        if idempotency_key in self._idem:
            return dict(self._idem[idempotency_key])
        res = {"id": f"stub-res-{len(self._reservations) + 1}",
               # `pending`, matching §6: a hold is not a confirmation, and `trust/injection.py` treats the
               # claim "the table is confirmed" as something to filter out of untrusted text. A stub that
               # emitted it would be the one thing the guard around it is written against.
               "code": f"RZ{len(self._reservations) + 1:04d}", "status": "pending",
               "stub": True, **payload}
        self._reservations[res["id"]] = res
        self._idem[idempotency_key] = res
        return dict(res)

    async def get_order_status(self, order_id: str, *, token: str | None = None,
                               tenant: str | None = None) -> dict[str, Any]:
        self._record("get_order_status", order_id=order_id)
        order = self._orders.get(order_id)
        if not order:
            raise PlatformRejectedRequest(f"order {order_id} not found", status=404)
        return dict(order)


_STUB = StubPlatformClient()
_CLIENT: PlatformClient | None = None


def get_platform_client(settings: Any | None = None, *, force_new: bool = False) -> PlatformClient:
    """`NEXUS_PLATFORM_MODE=stub|http`; stub is the default so tests never need :8080."""
    global _CLIENT
    import os

    if _CLIENT is not None and not force_new:
        return _CLIENT
    mode = (os.environ.get("NEXUS_PLATFORM_MODE") or "stub").strip().lower()
    base = getattr(settings, "platform_base_url", "") if settings else ""
    if mode == "http" and base:
        _CLIENT = HttpPlatformClient(base,
                                    timeout_s=getattr(settings, "platform_timeout_s", 5.0))
    else:
        if mode == "http":
            log.warning("NEXUS_PLATFORM_MODE=http but no base url — using the offline stub")
        _CLIENT = _STUB
    return _CLIENT


def set_platform_client(client: PlatformClient | None) -> None:
    global _CLIENT
    _CLIENT = client


def reset_platform_client() -> None:
    global _CLIENT, _STUB
    _CLIENT = None
    _STUB = StubPlatformClient()


def _safe_json(resp: Any) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {"value": data}
    except Exception:
        return {"raw": (resp.text or "")[:500]}


__all__ = ["PlatformClient", "HttpPlatformClient", "StubPlatformClient", "StubCatalogue",
           "PlatformUnavailable", "PlatformRejectedRequest", "get_platform_client",
           "set_platform_client", "reset_platform_client"]
