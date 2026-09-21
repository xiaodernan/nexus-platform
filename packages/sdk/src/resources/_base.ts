/**
 * Base class for namespaced resources. Wraps {@link HttpClient} with the small
 * verbs every resource needs plus a cursor {@link paged} builder.
 */
import type { HttpClient, RequestSpec } from "../http.js";
import { normalizePage, PagedRequest } from "../cursor.js";
import type { Page, QueryParams } from "../types.js";

export abstract class Resource {
  constructor(protected readonly http: HttpClient) {}

  protected reqGet<T>(path: string, query?: QueryParams, extra?: Partial<RequestSpec>): Promise<T> {
    return this.http.request<T>({ method: "GET", path, query, ...extra });
  }

  protected post<T>(path: string, body?: unknown, extra?: Partial<RequestSpec>): Promise<T> {
    return this.http.request<T>({ method: "POST", path, body, ...extra });
  }

  protected patch<T>(path: string, body?: unknown, extra?: Partial<RequestSpec>): Promise<T> {
    return this.http.request<T>({ method: "PATCH", path, body, ...extra });
  }

  protected put<T>(path: string, body?: unknown, extra?: Partial<RequestSpec>): Promise<T> {
    return this.http.request<T>({ method: "PUT", path, body, ...extra });
  }

  protected del<T>(path: string, extra?: Partial<RequestSpec>): Promise<T> {
    return this.http.request<T>({ method: "DELETE", path, ...extra });
  }

  /**
   * Build an awaitable + async-iterable cursor request. `query` may include any
   * filters; `cursor` is injected per page automatically.
   */
  protected paged<T>(path: string, query?: QueryParams): PagedRequest<T> {
    return new PagedRequest<T>(async (cursor) => {
      const merged: QueryParams = { ...query };
      if (cursor) merged.cursor = cursor;
      const raw = await this.http.request<unknown>({ method: "GET", path, query: merged });
      return normalizePage<T>(raw) as Page<T>;
    });
  }
}
