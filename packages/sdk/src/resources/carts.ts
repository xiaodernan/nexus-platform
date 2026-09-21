/**
 * `carts` — the universal cart (products + services + reservations, §41).
 * Checkout is idempotency-required; the SDK adds an `Idempotency-Key` (or uses
 * the caller's) and replays the first result for a repeated key, so a crash
 * retry cannot double-charge (§20, §103).
 */
import { Resource } from "./_base.js";

export interface CartItemInput {
  offering_id?: string;
  reservation_id?: string;
  quantity?: number;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PriceCheckResult {
  items: Array<{ item_id?: string; stale?: boolean; price?: unknown; [key: string]: unknown }>;
  total?: unknown;
  currency?: string;
  [key: string]: unknown;
}

export interface CheckoutResult {
  order: Record<string, unknown>;
  payment_intent: Record<string, unknown>;
  [key: string]: unknown;
}

export class CartsResource extends Resource {
  /** `POST /api/v1/carts` — anonymous allowed (server assigns `session_id`). */
  create(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/carts", body ?? {});
  }

  /** `GET /api/v1/carts/current`. */
  current(): Promise<Record<string, unknown>> {
    return this.reqGet("/api/v1/carts/current");
  }

  /** `POST /api/v1/carts/items` — server re-prices + TTL check. */
  addItem(body: CartItemInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/carts/items", body);
  }

  /** `PATCH /api/v1/carts/items/{id}`. */
  updateItem(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.patch(`/api/v1/carts/items/${encodeURIComponent(id)}`, body);
  }

  /** `DELETE /api/v1/carts/items/{id}`. */
  removeItem(id: string): Promise<void> {
    return this.del(`/api/v1/carts/items/${encodeURIComponent(id)}`);
  }

  /**
   * `POST /api/v1/carts/price-check` — per-item `stale` flags before checkout.
   * Never silently charge a stale price (§20, §103): inspect `items[].stale`.
   */
  priceCheck(body?: Record<string, unknown>): Promise<PriceCheckResult> {
    return this.post<PriceCheckResult>("/api/v1/carts/price-check", body ?? {});
  }

  /** `POST /api/v1/carts/checkout` — Idempotency-Key required. */
  checkout(body: Record<string, unknown>, idempotencyKey?: string): Promise<CheckoutResult> {
    return this.post<CheckoutResult>("/api/v1/carts/checkout", body, { requireIdempotency: true, idempotencyKey });
  }
}
