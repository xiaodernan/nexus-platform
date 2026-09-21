/**
 * `me` — the authenticated account surface (contract §3): profile, preferences
 * (user-visible/editable/deletable §32-33), favorites, saved searches, personal
 * data export, account deletion, and the account's orders/reservations/chats.
 */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { Page, QueryParams } from "../types.js";

export interface MeProfile {
  user?: Record<string, unknown>;
  memberships?: Array<Record<string, unknown>>;
  preferences?: Record<string, unknown>;
  [key: string]: unknown;
}

class PreferencesResource extends Resource {
  list(): Promise<Page<Record<string, unknown>> | Record<string, unknown>[]> {
    return this.reqGet("/api/v1/me/preferences");
  }
  update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.patch(`/api/v1/me/preferences/${encodeURIComponent(id)}`, body);
  }
  remove(id: string): Promise<void> {
    return this.del(`/api/v1/me/preferences/${encodeURIComponent(id)}`);
  }
  /** `POST /api/v1/me/personalization/reset` — wipes inferred memory. */
  resetPersonalization(): Promise<Record<string, unknown>> {
    return this.post("/api/v1/me/personalization/reset", {});
  }
}

class FavoritesResource extends Resource {
  list(): Promise<unknown> {
    return this.reqGet("/api/v1/me/favorites");
  }
  add(body: { type: string; id: string; [key: string]: unknown }): Promise<unknown> {
    return this.post("/api/v1/me/favorites", body);
  }
  remove(type: string, id: string): Promise<void> {
    return this.del(`/api/v1/me/favorites/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  }
}

class SavedSearchesResource extends Resource {
  list(): Promise<unknown> {
    return this.reqGet("/api/v1/me/saved-searches");
  }
  create(body: Record<string, unknown>): Promise<unknown> {
    return this.post("/api/v1/me/saved-searches", body);
  }
  remove(id: string): Promise<void> {
    return this.del(`/api/v1/me/saved-searches/${encodeURIComponent(id)}`);
  }
}

export class MeResource extends Resource {
  readonly preferences: PreferencesResource;
  readonly favorites: FavoritesResource;
  readonly savedSearches: SavedSearchesResource;

  constructor(http: import("../http.js").HttpClient) {
    super(http);
    this.preferences = new PreferencesResource(http);
    this.favorites = new FavoritesResource(http);
    this.savedSearches = new SavedSearchesResource(http);
  }

  /** `GET /api/v1/me` — profile + memberships + preferences summary. */
  profile(): Promise<MeProfile> {
    return this.reqGet<MeProfile>("/api/v1/me");
  }

  /** Alias for {@link profile}. */
  get(): Promise<MeProfile> {
    return this.profile();
  }

  /** `PATCH /api/v1/me`. */
  update(body: Record<string, unknown>): Promise<MeProfile> {
    return this.patch<MeProfile>("/api/v1/me", body);
  }

  /** `DELETE /api/v1/me` — creates a `deletion_request` (§106). */
  deleteAccount(): Promise<Record<string, unknown>> {
    return this.del<Record<string, unknown>>("/api/v1/me");
  }

  /** `GET /api/v1/me/export` — streaming JSON of all personal data (§106). */
  export(query?: QueryParams): Promise<unknown> {
    return this.reqGet("/api/v1/me/export", query);
  }

  /** `GET /api/v1/me/orders` (paged). */
  orders(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/me/orders", query);
  }

  /** `GET /api/v1/me/reservations` (paged). */
  reservations(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/me/reservations", query);
  }

  /** `GET /api/v1/me/conversations` (paged). */
  conversations(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/me/conversations", query);
  }
}
