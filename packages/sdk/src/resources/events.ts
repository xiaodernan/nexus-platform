/**
 * `events` — the ingestion endpoint plus the batching emitter (AGENT_CONTRACT §10).
 *
 * `client.events.track(...)` accumulates events client-side and flushes them in
 * de-duplicated, retried batches; `client.events.ingest(...)` posts a batch you
 * manage yourself. Every batch carries a stable Idempotency-Key so a crash retry
 * cannot double-count.
 */
import { Resource } from "./_base.js";
import { EventTracker, type EventTrackerOptions } from "../events.js";
import type { TrackEventInput, TrackedEvent } from "../types.js";

export class EventsResource extends Resource {
  private defaultTracker: EventTracker | undefined;

  /** Manual batch send (no client-side buffering). Idempotency-Key required. */
  ingest(events: TrackedEvent[], idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>("/api/v1/events", { events }, { requireIdempotency: true, idempotencyKey });
  }

  /** Create an independent emitter wired to this resource. */
  createTracker(options?: EventTrackerOptions): EventTracker {
    return new EventTracker(async (events, key) => {
      await this.postBatch(events, key);
    }, options);
  }

  /** Track on a lazily-created shared emitter. Returns false if the `event_id` was a duplicate. */
  track(input: TrackEventInput): boolean {
    return (this.defaultTracker ??= this.createTracker()).track(input);
  }

  /** Flush the shared emitter (creates it if needed). */
  flush(): Promise<void> {
    return (this.defaultTracker ??= this.createTracker()).flush();
  }

  /** Flush + stop the shared emitter, then drop it so a later track() rebuilds. */
  async close(): Promise<void> {
    const tracker = this.defaultTracker;
    if (!tracker) return;
    this.defaultTracker = undefined;
    await tracker.close();
  }

  private postBatch(events: TrackedEvent[], key: string): Promise<unknown> {
    // Explicit `idempotencyKey` (stable per batch) → transport retry + replay are safe.
    return this.http.request({ method: "POST", path: "/api/v1/events", body: { events }, idempotencyKey: key });
  }
}
