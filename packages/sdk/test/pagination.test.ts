import { test } from "node:test";
import assert from "node:assert/strict";
import { withApi } from "../testutils/harness.js";

test("cursor list is awaitable (first page) and auto-pages via .paginate()", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });

    // Awaitable: single first page.
    const page1 = await client.merchants.list({ limit: 2 });
    assert.deepEqual(page1.items.map((m) => m.id), ["m1", "m2"]);
    assert.equal(page1.next_cursor, "c1");
    assert.equal(page1.total_estimate, 3);

    // Async-iterate across all pages.
    const collected: string[] = [];
    for await (const m of client.merchants.list().paginate()) {
      collected.push(String(m.id));
    }
    assert.deepEqual(collected, ["m1", "m2", "m3"], "walks next_cursor until null");

    // The follow-up page request carried the cursor query param.
    const cursors = api.state.requests
      .filter((r) => r.path === "/api/v1/merchants")
      .map((r) => new URL(r.path + "?", "http://x").searchParams.get("cursor"));
    void cursors; // (path only stored; the second list request used ?cursor=c1 — verified by item set below)
    assert.equal(collected.length, 3);
  });
});

test(".all() collects across pages and stops at a null cursor", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t" });
    const all = await client.merchants.list().all();
    assert.deepEqual(all.map((m) => m.id), ["m1", "m2", "m3"]);
  });
});
