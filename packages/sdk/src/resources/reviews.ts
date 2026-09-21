/**
 * `reviews` — post a review for a merchant (contract §6). Verified
 * purchase/reservation flags are computed server-side; the client cannot assert
 * them (§109 no fake reviews). Create is idempotency-required.
 */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { QueryParams } from "../types.js";

export class ReviewsResource extends Resource {
  /** `POST /api/v1/merchants/{id}/reviews`. Idempotency-Key required. */
  create(merchantId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchants/${encodeURIComponent(merchantId)}/reviews`, body, {
      requireIdempotency: true,
      idempotencyKey,
    });
  }

  /** `GET /api/v1/merchants/{id}/reviews?sort=recent|helpful` (paged). */
  list(merchantId: string, query?: QueryParams & { sort?: "recent" | "helpful" }): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>(`/api/v1/merchants/${encodeURIComponent(merchantId)}/reviews`, query);
  }
}
