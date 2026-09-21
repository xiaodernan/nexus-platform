/**
 * Cursor pagination helper.
 *
 * A list method returns a {@link PagedRequest}, which is *both* awaitable (a
 * single page) and async-iterable via `.paginate()` (walk every page until
 * `next_cursor` is null). This is what powers:
 *
 *   for await (const m of client.merchants.list().paginate()) { ... }
 *
 * (contract §1 cursor format).
 */
import type { Page } from "./types.js";

/** Coerce a raw list response into a well-formed {@link Page}. */
export function normalizePage<T>(raw: unknown): Page<T> {
  const obj = (raw ?? {}) as Partial<Page<T>>;
  const items = Array.isArray(obj.items) ? (obj.items as T[]) : [];
  const next = typeof obj.next_cursor === "string" && obj.next_cursor.length > 0 ? obj.next_cursor : null;
  return { items, next_cursor: next, total_estimate: obj.total_estimate ?? null };
}

export class PagedRequest<T> implements PromiseLike<Page<T>> {
  constructor(private readonly load: (cursor?: string | undefined) => Promise<Page<T>>) {}

  /** Fetch a single page (optionally from an explicit cursor). */
  fetch(cursor?: string): Promise<Page<T>> {
    return this.load(cursor);
  }

  /** Awaitable: `await client.merchants.list()` yields the first {@link Page}. */
  then<R1 = Page<T>, R2 = never>(onfulfilled?: ((value: Page<T>) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.fetch().then(onfulfilled, onrejected);
  }

  /** Async-iterate every item across every page. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await this.load(cursor);
      for (const item of page.items) yield item;
      cursor = page.next_cursor ?? undefined;
      if (!cursor) return;
      // Defensive guard against a server echoing the same cursor forever.
      if (++guard > 100000) return;
    }
  }

  /**
   * Alias used in the public examples; returns an async iterable over every
   * item on every page. Each call yields a fresh, independent iteration.
   */
  paginate(): AsyncIterable<T> {
    return this;
  }

  /** Convenience: collect every page into one array (careful with large sets). */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}
