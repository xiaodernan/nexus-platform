import { test } from "node:test";
import assert from "node:assert/strict";
import { withApi } from "../testutils/harness.js";
import { InMemoryIdempotencyStore } from "../src/index.js";

const checkoutBody = { cart_id: "cart_1" };

test("checkout auto-supplies an Idempotency-Key header", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const result = await client.carts.checkout(checkoutBody);
    assert.equal(result.order.id, "ord_1");
    assert.equal(api.state.checkoutCreations, 1);
    assert.equal(api.state.seenIdempotencyKeys.length, 1, "a key was generated + sent");
  });
});

test("same client + same key replays from cache WITHOUT a second network call", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const first = await client.carts.checkout(checkoutBody, "key-replay");
    const second = await client.carts.checkout(checkoutBody, "key-replay");
    assert.deepEqual(second, first);
    assert.equal(api.state.checkoutRequests, 1, "replayed from the idempotency store, not re-sent");
    assert.equal(api.state.checkoutCreations, 1);
  });
});

test("different clients + same key: the SERVER dedupes so only one order is created", async () => {
  await withApi(async ({ api, make }) => {
    const a = make({ token: "t" });
    const b = make({ token: "t" }); // fresh idempotency store → must reach the network
    const r1 = await a.carts.checkout(checkoutBody, "key-server");
    const r2 = await b.carts.checkout(checkoutBody, "key-server");
    assert.deepEqual(r1.order, r2.order, "server replayed the original result");
    assert.equal(api.state.checkoutRequests, 2, "both clients hit the network once");
    assert.equal(api.state.checkoutCreations, 1, "but only one order was ever created (no double-charge)");
  });
});

test("distinct keys create distinct orders", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    await client.carts.checkout(checkoutBody, "k-a");
    await client.carts.checkout(checkoutBody, "k-b");
    assert.equal(api.state.checkoutCreations, 2);
  });
});

test("a custom (empty) idempotency store still yields correct single creation", async () => {
  await withApi(async ({ api }) => {
    const store = new InMemoryIdempotencyStore();
    const { createClient } = await import("../src/index.js");
    const client = createClient({ baseUrl: api.baseUrl, token: "t", retries: 1, backoffBaseMs: 1, idempotencyStore: store });
    await client.carts.checkout(checkoutBody, "k-store");
    assert.equal(store.size, 1);
    assert.equal(api.state.checkoutCreations, 1);
  });
});

test("reservation create requires and sends an Idempotency-Key, returning 201 code", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const res = await client.reservations.create({ merchant_id: "m1", slot_id: "s1", party_size: 2, contact: { phone: "+852 1234" } });
    // `pending`, never `confirmed`: this client's fixture used to answer a state no platform route can
    // produce (§6, D26), which trained callers to expect a merchant decision that has not happened.
    assert.equal(res.status, "pending");
    assert.equal(res.code, "RK7Q2");
    assert.equal(api.state.reserveRequests, 1);
  });
});
