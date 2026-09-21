import { test } from "node:test";
import assert from "node:assert/strict";
import { EventTracker, batchIdempotencyKey, type EventTrackerOptions } from "../src/events.js";
import type { TrackedEvent } from "../src/types.js";
import { withApi } from "../testutils/harness.js";

type Scheduler = (fn: () => void, ms: number) => unknown;
const immediate: Scheduler = (fn) => {
  fn();
  return undefined;
};

function ev(id: string): TrackedEvent {
  return { event_id: id, name: "view", occurred_at: new Date(0).toISOString() };
}

test("coalesces up to max-size into ONE send", async () => {
  const batches: TrackedEvent[][] = [];
  const t = new EventTracker(async (e) => void batches.push(e), { maxBufferSize: 3, flushIntervalMs: 0 });
  t.track({ name: "view", event_id: "a" });
  t.track({ name: "click", event_id: "b" });
  assert.equal(batches.length, 0, "not flushed until the size threshold");
  t.track({ name: "favorite", event_id: "c" }); // hits maxBufferSize=3 → auto flush
  await t.flush();
  assert.equal(batches.length, 1, "exactly one batched request");
  assert.deepEqual(batches[0]?.map((e) => e.event_id).sort(), ["a", "b", "c"]);
  assert.equal(t.pendingCount, 0);
});

test("de-dupes by event_id so a crash/retry cannot double-count", async () => {
  const batches: TrackedEvent[][] = [];
  const t = new EventTracker(async (e) => void batches.push(e), { maxBufferSize: 10, flushIntervalMs: 0 });
  assert.equal(t.track(ev("dup")), true);
  assert.equal(t.track(ev("dup")), false, "second identical id rejected client-side");
  await t.flush();
  assert.equal(batches[0]?.length, 1);
  // And it never reaches the server twice even after another explicit flush.
  await t.flush();
  assert.equal(batches.length, 1);
});

test("flushes on max-age via the timer", async () => {
  const cbs: Array<() => void> = [];
  const scheduler: Scheduler = (fn) => {
    cbs.push(fn);
    return cbs.length;
  };
  const batches: TrackedEvent[][] = [];
  const t = new EventTracker(async (e) => void batches.push(e), {
    maxBufferSize: 1000,
    flushIntervalMs: 500,
    setTimeoutImpl: scheduler,
  });
  t.track({ name: "search", event_id: "x" });
  assert.equal(batches.length, 0, "size threshold not reached");
  cbs[0]?.(); // fire the age timer
  await t.flush();
  assert.equal(batches.length, 1, "age timer triggered a flush");
  assert.deepEqual(batches[0]?.map((e) => e.event_id), ["x"]);
});

test("retries a failing batch (stable key) and delivers it once, without loss", async () => {
  const delivered: TrackedEvent[][] = [];
  let attempts = 0;
  const t = new EventTracker(
    async (e) => {
      attempts++;
      if (attempts < 3) throw new Error("flaky");
      delivered.push(e);
    },
    { maxBufferSize: 10, flushIntervalMs: 0, maxRetries: 5, retryBaseMs: 0, setTimeoutImpl: immediate },
  );
  t.track(ev("r1"));
  await t.flush();
  assert.equal(attempts, 3, "retried until success");
  assert.equal(delivered.length, 1, "delivered exactly once");
  assert.equal(t.pendingCount, 0);
});

test("drops only after maxRetries and reports it (never silent)", async () => {
  let errored: TrackedEvent[] | undefined;
  const opts: EventTrackerOptions = { maxBufferSize: 10, flushIntervalMs: 0, maxRetries: 2, retryBaseMs: 0, setTimeoutImpl: immediate, onError: (_e, batch) => (errored = batch) };
  const t = new EventTracker(async () => {
    throw new Error("down");
  }, opts);
  t.track(ev("lost"));
  await t.flush();
  assert.ok(errored && errored.length === 1, "onError surfaced the dropped batch");
  assert.equal(t.pendingCount, 0);
});

test("fills in event_id + ISO occurred_at when omitted", async () => {
  const batches: TrackedEvent[][] = [];
  const t = new EventTracker(async (e) => void batches.push(e), { maxBufferSize: 1, flushIntervalMs: 0, now: () => Date.UTC(2026, 8, 22) });
  t.track({ name: "view" });
  await t.flush();
  const sent = batches[0]?.[0];
  assert.ok(sent && typeof sent.event_id === "string" && sent.event_id.length > 0);
  assert.equal(sent.occurred_at, "2026-09-22T00:00:00.000Z");
});

test("close() flushes buffered events", async () => {
  const batches: TrackedEvent[][] = [];
  const t = new EventTracker(async (e) => void batches.push(e), { maxBufferSize: 100, flushIntervalMs: 0 });
  t.track(ev("c1"));
  await t.close();
  assert.deepEqual(batches[0]?.map((e) => e.event_id), ["c1"]);
});

test("batchIdempotencyKey is order-independent", () => {
  assert.equal(batchIdempotencyKey(["a", "b", "c"]), batchIdempotencyKey(["c", "a", "b"]));
  assert.notEqual(batchIdempotencyKey(["a", "b"]), batchIdempotencyKey(["a", "c"]));
});

test("client.events batches + de-dupes against the API and sends a stable key", async () => {
  await withApi(async ({ api, make }) => {
    const client = make({ token: "t" });
    const tracker = client.events.createTracker({ maxBufferSize: 2, flushIntervalMs: 0 });
    tracker.track({ name: "view", event_id: "e1", subject_type: "merchant", subject_id: "m1" });
    tracker.track({ name: "click", event_id: "e2", subject_type: "merchant", subject_id: "m2" });
    await tracker.flush();

    assert.equal(api.state.eventIngestCalls, 1);
    assert.deepEqual([...api.state.seenEventIds].sort(), ["e1", "e2"]);
    assert.ok(api.state.seenIdempotencyKeys.some((k) => k.startsWith("evt_")), "batch sent with an evt_ idempotency key");

    // A second flush with a re-sent id is deduped client-side (never counted twice).
    assert.equal(tracker.track({ name: "view", event_id: "e1" }), false);
    await tracker.flush();
    assert.equal(api.state.seenEventIds.length, 2, "server never saw e1 twice");
    await tracker.close();
  });
});
