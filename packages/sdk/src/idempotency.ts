/**
 * `Idempotency-Key` support: generation + a replay cache (contract §1).
 *
 * Callers may pass a stable key for a state-changing, idempotency-required
 * operation (checkout, payment confirm, reservation create, review create,
 * campaign publish). When the same key is seen again the SDK replays the first
 * recorded response instead of re-sending, so a retry after a crash cannot
 * double-charge or double-create.
 */
import { newIdempotencyKey } from "./util.js";

/** The recorded result for a completed idempotent request. */
export interface IdempotencyRecord {
  status: number;
  /** Whether the recorded response was a success (2xx). */
  ok: boolean;
  /** Parsed response body (data for `ok`, error envelope otherwise). */
  body: unknown;
  createdAt: number;
  /** The `X-Request-Id` sent on the original request, for log correlation. */
  requestId?: string;
}

/** Storage contract for the replay cache; implement this to persist across restarts. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | Promise<IdempotencyRecord | undefined>;
  set(key: string, value: IdempotencyRecord): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
}

/** Default in-memory store with an LRU-ish cap and optional TTL. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();
  constructor(private readonly maxEntries = 1000, private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  get(key: string): IdempotencyRecord | undefined {
    const rec = this.map.get(key);
    if (!rec) return undefined;
    if (this.ttlMs > 0 && Date.now() - rec.createdAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, rec);
    return rec;
  }

  set(key: string, value: IdempotencyRecord): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Return the caller's key, or generate a fresh one. Keys are always non-empty strings. */
export function resolveIdempotencyKey(key?: string): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  return trimmed.length > 0 ? trimmed : newIdempotencyKey();
}
