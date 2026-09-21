import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, backoffDelay } from "../src/util.js";
import { InMemoryIdempotencyStore, resolveIdempotencyKey } from "../src/idempotency.js";
import { parseSseStream, type SseFrame } from "../src/sse.js";
import { PagedRequest, normalizePage } from "../src/cursor.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function frames(chunks: string[]): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSseStream(streamFrom(chunks))) out.push(f);
  return out;
}

test("parseRetryAfter handles delta-seconds, HTTP-date and garbage", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
  const soon = new Date(Date.now() + 3000).toUTCString();
  const ms = parseRetryAfter(soon);
  assert.ok(ms !== undefined && ms >= 2000 && ms <= 3200, `expected ~3000, got ${ms}`);
});

test("backoffDelay is full-jitter bounded by exponential cap", () => {
  for (let a = 0; a < 6; a++) {
    const bound = Math.min(8000, 250 * Math.pow(2, a));
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(a, 250, 8000);
      assert.ok(d >= 0 && d <= bound + 1e-9, `attempt ${a}: ${d} out of [0, ${bound}]`);
    }
  }
});

test("InMemoryIdempotencyStore evicts oldest beyond maxEntries", () => {
  const store = new InMemoryIdempotencyStore(2, 60_000);
  const now = Date.now();
  store.set("a", { status: 200, ok: true, body: 1, createdAt: now });
  store.set("b", { status: 200, ok: true, body: 2, createdAt: now });
  store.set("c", { status: 200, ok: true, body: 3, createdAt: now });
  assert.equal(store.size, 2);
  assert.equal(store.get("a"), undefined, "oldest evicted");
  assert.ok(store.get("c"));
});

test("resolveIdempotencyKey trims supplied keys and generates otherwise", () => {
  assert.equal(resolveIdempotencyKey("  abc  "), "abc");
  const gen = resolveIdempotencyKey("   ");
  assert.match(gen, /^idem_/);
  assert.notEqual(gen, resolveIdempotencyKey(""));
});

test("normalizePage tolerates missing items/cursor", () => {
  assert.deepEqual(normalizePage(undefined), { items: [], next_cursor: null, total_estimate: null });
  assert.deepEqual(normalizePage({ items: [1, 2], next_cursor: "" }), { items: [1, 2], next_cursor: null, total_estimate: null });
});

test("PagedRequest stops at a null cursor (no infinite loop on echo)", async () => {
  let calls = 0;
  const pr = new PagedRequest<number>(async (cursor) => {
    calls++;
    if (!cursor) return { items: [1, 2], next_cursor: "c1", total_estimate: null };
    return { items: [3], next_cursor: null, total_estimate: null };
  });
  const collected: number[] = [];
  for await (const x of pr.paginate()) collected.push(x);
  assert.deepEqual(collected, [1, 2, 3]);
  assert.equal(calls, 2);
});

test("SSE parser folds multi-line data, defaults event, and survives a CRLF split across chunks", async () => {
  const f = await frames([
    "event: status\r", // terminator split across the next chunk...
    "\ndata: {\"stage\":\"a\",\"text\":\"x\"}\r",
    "\n\r\n", // ...blank-line terminator split
    ": keep-alive comment\n",
    "data: line1\ndata: line2\n",
    "\n",
  ]);
  assert.equal(f.length, 2);
  assert.equal(f[0]?.event, "status");
  assert.equal(f[0]?.data, '{"stage":"a","text":"x"}');
  assert.equal(f[1]?.event, "message", "default event name");
  assert.equal(f[1]?.data, "line1\nline2", "multi-line data joined with \\n");
});

test("SSE parser emits a final frame when the stream closes without a trailing blank line", async () => {
  const f = await frames(["event: done", "\n", "data: {\"ok\":true}"]);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.event, "done");
  assert.equal(f[0]?.data, '{"ok":true}');
});
