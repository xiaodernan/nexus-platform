/**
 * `EventTracker` — the small events emitter (AGENT_CONTRACT §10).
 *
 * Batches `POST /api/v1/events` with a max-size / max-age flush and de-dupes by
 * `event_id`, so a client crash cannot lose an event (a failed batch is re-queued
 * and retried, and the batch is sent with a stable Idempotency-Key derived from
 * its event ids so the server can replay/dedup) or double-count it (a repeat
 * `event_id` is dropped client-side, and the server dedups by `event_id`).
 *
 * Transport is injected via `send`, keeping this free of HTTP specifics and easy
 * to unit-test.
 */
import type { TrackedEvent, TrackEventInput } from "./types.js";
import { uuid } from "./util.js";

export interface EventTrackerOptions {
  /** Flush once this many events are buffered. Default 20. */
  maxBufferSize?: number;
  /** Flush buffered events at most this often (ms). `0` disables the timer. Default 5000. */
  flushIntervalMs?: number;
  /** Tracker-level attempts for a batch before it is dropped (each already HTTP-retried). Default 5. */
  maxRetries?: number;
  /** Cap on the de-dupe id set to bound memory. Default 10000. */
  seenLimit?: number;
  /** Backoff base between re-queued retries (ms). Default 500. */
  retryBaseMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injected scheduler (tests). Defaults to `setTimeout` (unref'd on Node). */
  setTimeoutImpl?: Scheduler;
  /** Called when a batch is permanently dropped after `maxRetries` — never silent (D6). */
  onError?: (err: unknown, events: TrackedEvent[]) => void;
}

/** Sends one batch. `idempotencyKey` is stable across retries of the same ids. */
export type EventSender = (events: TrackedEvent[], idempotencyKey: string) => Promise<void>;

/** A scheduler handle whose concrete type differs between Node and browsers. */
type TimerHandle = unknown;
type Scheduler = (fn: () => void, ms: number) => TimerHandle;

/** Deterministic, stable key for a set of event ids (order-independent). */
export function batchIdempotencyKey(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  // FNV-1a over the sorted ids → compact stable token.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  const s = sorted.join("|");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ (c + i)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `evt_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export class EventTracker {
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly seenLimit: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;
  private readonly setTimeoutImpl: Scheduler;
  private readonly onError?: (err: unknown, events: TrackedEvent[]) => void;

  private readonly buf: TrackedEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private timer: TimerHandle = undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;

  constructor(
    private readonly send: EventSender,
    options: EventTrackerOptions = {},
  ) {
    this.maxBufferSize = Math.max(1, options.maxBufferSize ?? 20);
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 5;
    this.seenLimit = Math.max(this.maxBufferSize, options.seenLimit ?? 10000);
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // In Node, keep the timer from holding the event loop open (browsers have no unref).
      const handle = t as unknown as { unref?: () => void };
      if (typeof handle.unref === "function") handle.unref();
      return t;
    });
    this.onError = options.onError;
    this.ensureTimer();
  }

  /** Number of events currently buffered (not yet acknowledged). */
  get pendingCount(): number {
    return this.pending;
  }

  /**
   * Enqueue an event. Returns `false` if the `event_id` was already accepted
   * (de-duped), `true` if it was queued. Never throws.
   */
  track(input: TrackEventInput): boolean {
    if (this.closed) return false;
    const eventId = input.event_id && input.event_id.trim().length > 0 ? input.event_id : uuid();
    if (this.seen.has(eventId)) return false; // dedupe: no double-count
    this.rememberSeen(eventId);

    const event: TrackedEvent = {
      ...input,
      event_id: eventId,
      name: input.name,
      occurred_at: input.occurred_at ?? new Date(this.now()).toISOString(),
    };
    this.buf.push(event);
    this.pending++;
    if (this.buf.length >= this.maxBufferSize) {
      void this.flush();
    }
    return true;
  }

  /** Kick a flush of everything currently buffered. Awaitable. */
  flush(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.drain());
    return this.inFlight;
  }

  /** Flush remaining events and stop the timer. Awaitable; safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    if (this.timer !== undefined) {
      clearTimeout(this.timer as unknown as ReturnType<typeof setTimeout>);
      this.timer = undefined;
    }
  }

  private rememberSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.seenLimit) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private ensureTimer(): void {
    if (this.flushIntervalMs <= 0 || this.timer || this.closed) return;
    this.timer = this.setTimeoutImpl(() => {
      this.timer = undefined;
      if (this.buf.length > 0 && !this.closed) void this.flush();
      this.ensureTimer();
    }, this.flushIntervalMs);
  }

  /**
   * Coalesce buffered events into a single batch per flush and deliver it with
   * bounded retries. A failed batch is retried up to `maxRetries`; only then is
   * it dropped, and the drop is surfaced via `onError` (never silent, D6).
   */
  private async drain(): Promise<void> {
    while (this.buf.length > 0) {
      const events = this.buf.splice(0, this.buf.length);
      await this.deliver(events);
    }
  }

  private async deliver(events: TrackedEvent[]): Promise<void> {
    const key = batchIdempotencyKey(events.map((e) => e.event_id));
    for (let attempt = 0; ; attempt++) {
      try {
        await this.send(events, key);
        this.pending = Math.max(0, this.pending - events.length);
        return;
      } catch (err) {
        if (attempt >= this.maxRetries) {
          this.pending = Math.max(0, this.pending - events.length);
          if (this.onError) this.onError(err, events);
          return;
        }
        // Exponential backoff + jitter between retries of the same (stable-key) batch.
        await this.wait(this.retryBaseMs * Math.pow(2, attempt) * (0.5 + Math.random()));
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = this.setTimeoutImpl(resolve, Math.max(0, ms));
      void t;
    });
  }
}
