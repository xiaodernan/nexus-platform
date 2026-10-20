import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, isNexusApiError } from "../src/index.js";
import { withApi } from "../testutils/harness.js";

test("createClient exposes every documented namespace", () => {
  const c = createClient({ baseUrl: "http://localhost" });
  for (const ns of ["auth", "me", "merchants", "merchant", "discovery", "carts", "orders", "reservations", "payments", "reviews", "conversations", "events", "collections", "admin", "ai"] as const) {
    assert.ok(c[ns] && typeof c[ns] === "object", `client.${ns} present`);
  }
  assert.equal(typeof c.merchant.imports.wait, "function");
  assert.equal(typeof c.admin.moderation.resolve, "function");
  assert.equal(typeof c.me.preferences.resetPersonalization, "function");
});

test("merchant import flow: create → poll until `done` returns proposals (§5.1)", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const job = await client.merchant.imports.create({ merchant_id: "m1", source: { type: "url", value: "https://example.hk/menu" } });
    assert.equal(job.status, "queued");
    const finished = await client.merchant.imports.wait(job.job_id, { pollMs: 1, timeoutMs: 1000 });
    assert.equal(finished.status, "done");
    assert.ok(finished.proposals && finished.proposals.length === 1);
    assert.equal(finished.proposals?.[0]?.confidence, 0.9);
    assert.equal(api.state.importPolls, 2, "polled: running then done");
  });
});

test("tool registry exposes permission + side_effect so callers gate honestly", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t" });
    const { tools } = await client.ai.tools();
    const res = tools.find((t) => t.name === "create_reservation");
    assert.equal(res?.side_effect, true, "side-effect tools are flagged (require explicit user action)");
    assert.ok(tools.every((t) => typeof t.permission === "string"));
  });
});

test("campaign publish is an explicit human action and carries an Idempotency-Key (§27)", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const r = await client.merchant.campaigns.approvePublish("camp_1");
    assert.equal(r.status, "published");
    assert.equal(api.state.approvePublishCalls, 1);
    assert.ok(api.state.seenIdempotencyKeys.some((k) => k.startsWith("idem_")), "a key was auto-generated + sent");
  });
});

test("merchant analytics + ai deterministic search return structured results", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t" });
    const analytics = await client.merchant.analytics.get({ metric: "views" });
    assert.ok(Array.isArray(analytics.metrics));
    const search = await client.ai.search({ query: "coffee", limit: 5 });
    assert.equal(search.degraded, false);
    assert.equal(search.strategy, "hybrid_v1");
    assert.ok(search.items.length >= 1);
  });
});

test("a reservation is held, read back and released — and a client cannot ask to confirm it (D26)", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const held = await client.reservations.create({
      merchant_id: "m1", slot_id: "s1", party_size: 2, contact: { phone: "+852 1234" },
    });
    assert.equal(held.status, "pending", "the platform holds a table, it does not confirm one");

    const read = await client.reservations.get("res_1");
    assert.equal(read.reservation_id, "res_1");

    const released = await client.reservations.cancel("res_1", "Flights changed");
    assert.equal(released.status, "cancelled");
    const patch = api.state.requests
      .filter((r) => r.method === "PATCH" && r.path === "/api/v1/reservations/res_1")
      .pop();
    assert.deepEqual(patch?.body, { status: "cancelled", reason: "Flights changed" });

    // The typed method refuses any other target state at compile time (`status` narrows to
    // "cancelled"), so this goes through the raw transport to reach the guard on the wire — the server
    // refuses it too, which is the half that matters for a client that ignores its types.
    await assert.rejects(
      () => client.http.request({
        method: "PATCH", path: "/api/v1/reservations/res_1", body: { status: "confirmed" },
      }),
      (err: unknown) => {
        assert.ok(isNexusApiError(err));
        return err.status === 422;
      },
    );
  });
});
