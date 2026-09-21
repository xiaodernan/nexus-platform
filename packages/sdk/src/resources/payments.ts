/**
 * `payments` — confirm a payment against the demo provider (contract §6).
 * Confirm is idempotency-required; real providers are reconciled via the
 * signature-verified webhook server-side (not a client call). No card data is
 * ever handled by this SDK (DECISIONS D5).
 */
import { Resource } from "./_base.js";

export class PaymentsResource extends Resource {
  /** `POST /api/v1/payments/{order_id}/confirm` (demo provider). Idempotency-Key required. */
  confirm(orderId: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/payments/${encodeURIComponent(orderId)}/confirm`, body ?? {}, {
      requireIdempotency: true,
      idempotencyKey,
    });
  }
}
