/**
 * `discovery` — map/geo + cross-category browsing. Thin surface over the public
 * merchant reads (contract §4) so consumers can discover without holding a
 * merchant id.
 */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { QueryParams } from "../types.js";
import type { MerchantSummary } from "./merchants.js";

export interface GeoQuery {
  bbox: string | ReadonlyArray<number>;
  zoom?: number;
}

/** A clustered marker payload. */
export interface MapCluster {
  id?: string;
  lat?: number;
  lng?: number;
  count?: number;
  [key: string]: unknown;
}

export class DiscoveryResource extends Resource {
  /** `GET /api/v1/merchants` (paged) — discovery browse of all published merchants. */
  merchants(query?: QueryParams): PagedRequest<MerchantSummary> {
    return this.paged<MerchantSummary>("/api/v1/merchants", query);
  }

  /** `GET /api/v1/locations/geo?bbox=&zoom=` — marker clustering payload. */
  geo(query: GeoQuery): Promise<{ clusters: MapCluster[]; [key: string]: unknown }> {
    const normalized: QueryParams = {
      ...query,
      bbox: Array.isArray(query.bbox) ? query.bbox.join(",") : query.bbox,
    };
    return this.reqGet("/api/v1/locations/geo", normalized);
  }

  /** Real-time availability for a merchant (never cached, §20). */
  availability(merchantId: string, query?: QueryParams): Promise<Record<string, unknown>> {
    return this.reqGet(`/api/v1/merchants/${encodeURIComponent(merchantId)}/availability`, query);
  }
}
