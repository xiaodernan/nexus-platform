"""Platform boundary — `StubPlatformClient` is a *real* deterministic stand-in for :8080
(API_CONTRACT §0/§4/§6), so tests and the offline demo never need the Spring service. It is
not a rubber stamp: it validates idempotency keys (§1), rejects unpublished merchants
(§6), prices only from a supplied catalogue, enforces the §20 stale-price gate, and stamps
every payload `"stub": True` so nothing offline can be mistaken for a live order.

It had **no tests**. This pins the contract so the offline path cannot silently drift from
the live one. DB-free, async (pytest-asyncio auto mode).
"""

from __future__ import annotations

import pytest

from nexus_ai.adapters.platform import (
    IDEMPOTENCY_RE,
    PlatformRejectedRequest,
    StubCatalogue,
    StubPlatformClient,
    get_platform_client,
    reset_platform_client,
)


def _client() -> StubPlatformClient:
    c = StubPlatformClient(StubCatalogue())
    c.register_merchant("m1", name="Shop One")
    c.register_offering("o_active", price_amount=100.0, currency="HKD",
                        price_source="merchant", status="active")
    c.register_offering("o_second", price_amount=50.0, currency="HKD", status="active")
    c.register_offering("o_stale", price_amount=80.0, currency="HKD", status="active",
                        price_stale=True)
    c.register_offering("o_inactive", price_amount=20.0, currency="HKD", status="inactive")
    return c


# ------------------------------------------------------------- stub marker (never live)
async def test_every_stub_payload_is_marked_stub():
    c = _client()
    merchant = await c.get_merchant("m1")
    cart = await c.create_cart(merchant_id="m1")
    cart = await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=1)
    priced = await c.price_check(cart["id"])
    order = await c.checkout(cart_id=cart["id"], idempotency_key="idem-checkout-0001")
    res = await c.create_reservation(
        payload={"merchant_id": "m1", "slot_id": "s1", "party_size": 2, "contact": "a@b.hk"},
        idempotency_key="idem-res-0001")
    status = await c.get_order_status(order["id"])
    for payload in (merchant, cart, priced, order, res, status):
        assert payload.get("stub") is True


# ------------------------------------------------------------- merchant validation (§6)
async def test_get_merchant_rejects_unknown():
    c = _client()
    assert (await c.get_merchant("m1")).get("stub") is True
    with pytest.raises(PlatformRejectedRequest) as exc:
        await c.get_merchant("ghost")
    assert exc.value.status == 404


# ------------------------------------------------------------- offering / price (§6/§20)
async def test_add_unknown_offering_is_rejected():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    with pytest.raises(PlatformRejectedRequest) as exc:
        await c.add_cart_item(cart_id=cart["id"], offering_id="does_not_exist")
    # the stub never invents a price
    assert "never invents a price" in exc.value.args[0]
    assert exc.value.status == 422


async def test_add_inactive_offering_is_rejected():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    with pytest.raises(PlatformRejectedRequest) as exc:
        await c.add_cart_item(cart_id=cart["id"], offering_id="o_inactive")
    assert exc.value.status == 409


async def test_add_active_offering_builds_priced_item():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    cart = await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=2)
    item = cart["items"][0]
    assert item["unit_price"] == 100.0
    assert item["quantity"] == 2
    assert item["currency"] == "HKD"
    assert item["price_source"] == "merchant"
    assert cart["total"] == 200.0
    assert item.get("stale") is not True


async def test_stale_price_is_flagged_and_blocks_checkout():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    cart = await c.add_cart_item(cart_id=cart["id"], offering_id="o_stale", quantity=1)
    item = cart["items"][0]
    assert item["stale"] is True
    assert item["stale_copy"] == "價格可能已更新"  # §20 localisation
    priced = await c.price_check(cart["id"])
    assert priced["stale_count"] == 1
    with pytest.raises(PlatformRejectedRequest) as exc:
        await c.checkout(cart_id=cart["id"], idempotency_key="idem-stale-0001")
    assert exc.value.status == 409
    assert "stale price" in exc.value.args[0]


# ------------------------------------------------------------- idempotency (§1)
async def test_checkout_requires_valid_idempotency_key():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=1)
    for bad in ("", "abc", "spaces not allowed"):
        with pytest.raises(PlatformRejectedRequest) as exc:
            await c.checkout(cart_id=cart["id"], idempotency_key=bad)
        assert exc.value.status == 422


async def test_checkout_is_replay_safe():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=1)
    first = await c.checkout(cart_id=cart["id"], idempotency_key="idem-replay-0001")
    second = await c.checkout(cart_id=cart["id"], idempotency_key="idem-replay-0001")
    assert second["id"] == first["id"]
    assert second["code"] == first["code"]
    assert second["total"] == first["total"]


async def test_checkout_success_flow():
    c = _client()
    cart = await c.create_cart(merchant_id="m1")
    await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=1)
    await c.add_cart_item(cart_id=cart["id"], offering_id="o_second", quantity=1)
    priced = await c.price_check(cart["id"])
    assert priced["total"] == 150.0
    order = await c.checkout(cart_id=cart["id"], idempotency_key="idem-ok-0001")
    assert order["status"] == "pending_payment"
    assert order["total"] == 150.0
    assert order["payment_intent"]["stub"] is True
    # the cart is closed after checkout (no live mutation survives a checked-out cart)
    assert c._carts[order["cart_id"]]["status"] == "checked_out"


async def test_get_order_status_unknown_and_known():
    c = _client()
    with pytest.raises(PlatformRejectedRequest) as exc:
        await c.get_order_status("nope")
    assert exc.value.status == 404
    cart = await c.create_cart(merchant_id="m1")
    await c.add_cart_item(cart_id=cart["id"], offering_id="o_active", quantity=1)
    order = await c.checkout(cart_id=cart["id"], idempotency_key="idem-os-0001")
    assert (await c.get_order_status(order["id"]))["id"] == order["id"]


# ------------------------------------------------------------- reservations (§6)
async def test_create_reservation_requires_fields():
    c = _client()
    payload = {"merchant_id": "m1", "slot_id": "s1", "party_size": 2, "contact": "a@b.hk"}
    for missing in ("merchant_id", "slot_id", "party_size", "contact"):
        bad = {k: v for k, v in payload.items() if k != missing}
        with pytest.raises(PlatformRejectedRequest) as exc:
            await c.create_reservation(payload=bad, idempotency_key="idem-req-0001")
        assert exc.value.status == 422


async def test_create_reservation_holds_not_confirms():
    c = _client()
    res = await c.create_reservation(
        payload={"merchant_id": "m1", "slot_id": "s1", "party_size": 2, "contact": "a@b.hk"},
        idempotency_key="idem-hold-0001")
    # §6: a hold is "pending", never "confirmed" — the trust layer filters "confirmed" claims
    assert res["status"] == "pending"
    assert res["stub"] is True


async def test_create_reservation_is_replay_safe():
    c = _client()
    payload = {"merchant_id": "m1", "slot_id": "s1", "party_size": 2, "contact": "a@b.hk"}
    first = await c.create_reservation(payload=payload, idempotency_key="idem-res-replay")
    second = await c.create_reservation(payload=payload, idempotency_key="idem-res-replay")
    assert second["id"] == first["id"]


# ------------------------------------------------------------- idempotency regex (§1)
def test_idempotency_regex_bounds():
    assert IDEMPOTENCY_RE.match("idemp-Key_01:ab")          # mixed valid charset
    assert IDEMPOTENCY_RE.match("a" * 8)                    # min length
    assert IDEMPOTENCY_RE.match("a" * 128)                  # max length
    assert not IDEMPOTENCY_RE.match("a" * 7)                # too short
    assert not IDEMPOTENCY_RE.match("a" * 129)              # too long
    assert not IDEMPOTENCY_RE.match("has space")            # illegal char
    assert not IDEMPOTENCY_RE.match("")


# ------------------------------------------------------------- observability / wiring
async def test_ops_are_recorded():
    c = _client()
    await c.create_cart(merchant_id="m1")
    await c.get_merchant("m1")
    ops = [call["op"] for call in c.calls]
    assert "create_cart" in ops and "get_merchant" in ops


def test_default_client_is_stub():
    reset_platform_client()
    client = get_platform_client()
    assert getattr(client, "mode", None) == "stub"
