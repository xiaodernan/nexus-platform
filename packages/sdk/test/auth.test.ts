import { test } from "node:test";
import assert from "node:assert/strict";
import { withApi } from "../testutils/harness.js";
import { isNexusApiError } from "../src/index.js";

test("login injects bearer token and auth/tenant/locale/request-id headers on later calls", async () => {
  await withApi(async ({ api, make }) => {
    const client = make(); // no token yet

    // Before auth, /me must be rejected by the server (401 → typed error).
    await assert.rejects(() => client.me.profile(), (err: unknown) => isNexusApiError(err) && err.status === 401 && err.code === "unauthorized");

    const session = await client.auth.login({ email: "a@b.example", password: "pw" });
    assert.equal(session.access_token, "tok_demo_access");
    assert.equal(api.state.loginCalls, 1);

    // Now the bearer must be auto-injected.
    const profile = await client.me.profile();
    assert.equal((profile.user as { id?: string }).id, "usr_1");

    const h = api.state.meHeaders;
    assert.equal(h["authorization"], "Bearer tok_demo_access");
    assert.equal(h["x-tenant"], "hong-kong");
    assert.equal(h["accept-language"], "zh-HK");
    assert.ok(typeof h["x-request-id"] === "string" && (h["x-request-id"] as string).startsWith("req_"), "client generates X-Request-Id");
    assert.equal(h["accept"], "application/json");
  });
});

test("explicit token + api key are injected without login", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "tok_static", apiKey: "nk_live_123" });
    await client.me.profile();
    const h = api.state.meHeaders;
    assert.equal(h["authorization"], "Bearer tok_static");
    assert.equal(h["x-api-key"], "nk_live_123");
  });
});

test("caller-supplied X-Request-Id is honored (propagation, not regeneration)", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t", headers: { "X-Request-Id": "trace-abc" } });
    await client.me.profile();
    assert.equal(api.state.meHeaders["x-request-id"], "trace-abc");
  });
});
