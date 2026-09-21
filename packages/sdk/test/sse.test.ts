import { test } from "node:test";
import assert from "node:assert/strict";
import { withApi } from "../testutils/harness.js";
import type { AiStreamEvent } from "../src/index.js";

async function collect(gen: AsyncGenerator<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("happy-path AI search stream yields typed status/intent/results/summary/done", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const events = await collect(client.ai.searchStream({ query: "咖啡", scenario: "ok" }));
    assert.deepEqual(
      events.map((e) => e.type),
      ["status", "intent", "status", "results", "summary", "done"],
    );
    const results = events.find((e) => e.type === "results");
    assert.ok(results && results.type === "results" && results.items.length === 1);
    const done = events.at(-1);
    assert.ok(done && done.type === "done" && done.degraded === false);
    assert.equal(api.state.aiSearchCalls, 0, "no fallback needed on a healthy stream");
  });
});

test("stream that emits event:error degrades to deterministic search (never a fake success)", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const events = await collect(client.ai.searchStream({ query: "咖啡", scenario: "error" }));
    assert.equal(events.some((e) => e.type === "error"), true, "the error event is surfaced, not swallowed");
    assert.equal(events.some((e) => e.type === "done"), false, "no fake completion is emitted");
    const last = events.at(-1);
    assert.ok(last && last.type === "degraded" && last.degraded === true);
    assert.equal(last.via, "deterministic_search");
    assert.ok(last.result && last.result.items.length === 1, "fallback carried real deterministic results");
    assert.equal(api.state.aiSearchCalls, 1, "ai.search() was called as the fallback");
  });
});

test("stream that drops mid-flight degrades to deterministic search", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const events = await collect(client.ai.searchStream({ query: "咖啡", scenario: "drop" }));
    const last = events.at(-1);
    assert.ok(last && last.type === "degraded" && last.via === "deterministic_search");
    assert.ok(last.reason.length > 0, "a reason is always attached");
    assert.equal(api.state.aiStreamCalls, 1);
    assert.equal(api.state.aiSearchCalls, 1);
  });
});

test("a server-flagged degraded response is surfaced as a degraded event (X-Nexus-Degraded)", async () => {
  await withApi(async ({ make }) => {
    const client = make({ token: "t" });
    const events = await collect(client.ai.searchStream({ query: "咖啡", scenario: "server" }));
    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.degraded === true);
    const last = events.at(-1);
    assert.ok(last && last.type === "degraded" && last.via === "server");
  });
});
