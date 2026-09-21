/** `collections` — curated lists + guides (contract §8, growth/creator). */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { QueryParams } from "../types.js";

export class CollectionsResource extends Resource {
  /** `GET /api/v1/collections` (paged). */
  list(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/collections", query);
  }

  /** `POST /api/v1/collections`. */
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/collections", body);
  }

  /** `GET /api/v1/collections/{id}`. */
  get(id: string): Promise<Record<string, unknown>> {
    return super.reqGet<Record<string, unknown>>(`/api/v1/collections/${encodeURIComponent(id)}`);
  }

  /** `DELETE /api/v1/collections/{id}`. */
  remove(id: string): Promise<void> {
    return this.del(`/api/v1/collections/${encodeURIComponent(id)}`);
  }

  /** `GET /api/v1/guides/{slug}` — SSR + JSON-LD guide payload. */
  guide(slug: string): Promise<Record<string, unknown>> {
    return super.reqGet<Record<string, unknown>>(`/api/v1/guides/${encodeURIComponent(slug)}`);
  }
}
