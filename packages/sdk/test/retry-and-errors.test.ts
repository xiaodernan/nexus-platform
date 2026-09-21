import { test } from "node:test";
import assert from "node:assert/strict";
import { withApi } from "../testutils/harness.js";
import { isNexusApiError, NexusApiError } from "../src/index.js";

test("safe GET retries a 429 and honors Retry-After, then succeeds", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const result = await client.http.request<{ ok: boolean }>({ method: "GET", path: "/api/v1/rate-limited" });
    assert.equal(result.ok, true);
    assert.equal(api.state.rateLimitedCalls, 2, "first 429 was retried once to 200");
  });
});

test("non-idempotent POST is NOT retried on 429 and surfaces rate-limit headers", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const before = api.state.requests.length;
    await assert.rejects(
      () => client.http.request({ method: "POST", path: "/api/v1/always-429", body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(isNexusApiError(err));
        assert.equal(err.status, 429);
        assert.equal(err.code, "rate_limited");
        assert.equal(err.rateLimit?.["x-ratelimit-remaining"], "0");
        assert.ok(err.retryAfterMs !== undefined, "Retry-After parsed");
        return true;
      },
    );
    const hits = api.state.requests.slice(before).filter((r) => r.path === "/api/v1/always-429").length;
    assert.equal(hits, 1, "exactly one attempt — a double-submit is never auto-retried");
  });
});

test("error envelope maps to a typed NexusApiError (code/status/details/requestId)", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t" });
    const err = await client.http.request({ method: "GET", path: "/api/v1/boom" }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof NexusApiError);
    assert.equal(err.code, "merchant_not_found");
    assert.equal(err.status, 404);
    assert.equal(err.details?.merchant_id, "nope");
    assert.match(String(err.requestId), /^req_/, "request id propagated from the echo");
  });
});

test("per-request timeout aborts via AbortSignal (code=timeout)", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t", timeoutMs: 60, retries: 0 });
    await assert.rejects(
      () => client.http.request({ method: "GET", path: "/api/v1/slow?delay=400" }),
      (err: unknown) => isNexusApiError(err) && err.code === "timeout" && err.isTransportError,
    );
  });
});

test("caller AbortSignal composes with the SDK timeout (code=aborted)", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t", timeoutMs: 5000, retries: 0 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => client.http.request({ method: "GET", path: "/api/v1/slow?delay=1000", signal: controller.signal }),
      (err: unknown) => isNexusApiError(err) && err.code === "aborted",
    );
  });
});
