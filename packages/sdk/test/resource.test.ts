import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/index.js";
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
