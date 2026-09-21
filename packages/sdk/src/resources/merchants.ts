/**
 * `merchants` — public, cacheable consumer reads (contract §4). All list methods
 * return an awaitable + async-iterable cursor (`.paginate()`).
 */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { QueryParams } from "../types.js";

export interface MerchantListQuery extends QueryParams {
  district?: string;
  category?: string;
  max_price?: string | number;
  open_now?: boolean;
  rating?: number;
  limit?: number;
  cursor?: string;
}

export interface AvailabilityQuery extends QueryParams {
  starts_at?: string;
  ends_at?: string;
  party_size?: number;
}

/** A merchant list item; structural (the API is the source of truth). */
export interface MerchantSummary {
  id?: string;
  slug?: string;
  name?: string;
  title?: string;
  category?: string;
  district?: string;
  rating?: unknown;
  price?: unknown;
  flags?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AvailabilitySlot {
  slot_id?: string;
  starts_at?: string;
  party_size?: number;
  status?: string;
  [key: string]: unknown;
}

export interface MerchantDetail extends MerchantSummary {
  locations?: Array<Record<string, unknown>>;
  hours?: Array<Record<string, unknown>>;
  top_offerings?: Array<Record<string, unknown>>;
  review_summary?: Record<string, unknown>;
}

export class MerchantsResource extends Resource {
  /** `GET /api/v1/merchants` (paged). */
  list(query?: MerchantListQuery): PagedRequest<MerchantSummary> {
    return this.paged<MerchantSummary>("/api/v1/merchants", query);
  }

  /** `GET /api/v1/merchants/{id_or_slug}` — profile + locations + hours + top offerings + review summary. */
  get(idOrSlug: string): Promise<MerchantDetail> {
    return super.reqGet<MerchantDetail>(`/api/v1/merchants/${encodeURIComponent(idOrSlug)}`);
  }

  /** `GET /api/v1/merchants/{id}/menu` (paged offerings). */
  menu(id: string, query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>(`/api/v1/merchants/${encodeURIComponent(id)}/menu`, query);
  }

  /** `GET /api/v1/merchants/{id}/reviews?sort=recent|helpful` (paged). */
  reviews(id: string, query?: QueryParams & { sort?: "recent" | "helpful" }): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>(`/api/v1/merchants/${encodeURIComponent(id)}/reviews`, query);
  }

  /** `GET /api/v1/merchants/{id}/reviews/summary` — AI summary with review_ids as evidence (§55). */
  reviewSummary(id: string): Promise<Record<string, unknown>> {
    return super.reqGet<Record<string, unknown>>(`/api/v1/merchants/${encodeURIComponent(id)}/reviews/summary`);
  }

  /**
   * `GET /api/v1/merchants/{id}/availability` — real-time, never cached (§20).
   * Availability must never be fabricated (DECISIONS D6); an empty list is a
   * valid, designed state, not an error.
   */
  availability(id: string, query?: AvailabilityQuery): Promise<{ slots: AvailabilitySlot[]; [key: string]: unknown }> {
    return super.reqGet(`/api/v1/merchants/${encodeURIComponent(id)}/availability`, query);
  }
}
