/**
 * `admin` — platform console (contract §9). Every route requires
 * `role IN (platform_admin, platform_ops)` server-side and writes `audit_logs`.
 * The Admin Analytics Agent (`ai.ask`) is read-only by contract; this SDK adds
 * no capability beyond what the caller's token is already granted (§8 honesty).
 */
import { Resource } from "./_base.js";
import { PagedRequest } from "../cursor.js";
import type { QueryParams } from "../types.js";

class AdminAiResource extends Resource {
  /** `GET /api/v1/admin/ai/runs` (paged `agent_runs`). */
  runs(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/ai/runs", query);
  }
  /** `GET /api/v1/admin/ai/costs?group_by=agent|model|day`. */
  costs(query?: { group_by?: "agent" | "model" | "day" }): Promise<Record<string, unknown>> {
    return this.reqGet("/api/v1/admin/ai/costs", query);
  }
  /** `POST /api/v1/admin/ai/ask` — Admin Analytics Agent, read-only tools. */
  ask(question: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/admin/ai/ask", { question, ...body });
  }
}

class AdminModerationResource extends Resource {
  list(query?: QueryParams): Promise<unknown> {
    return this.reqGet("/api/v1/admin/moderation", query);
  }
  /** `POST /api/v1/admin/moderation/{case_id}/resolve {action, note}`. */
  resolve(caseId: string, body: { action: string; note?: string }): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/admin/moderation/${encodeURIComponent(caseId)}/resolve`, body);
  }
}

export class AdminResource extends Resource {
  readonly ai = new AdminAiResource(this.http);
  readonly moderation = new AdminModerationResource(this.http);

  users(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/users", query);
  }
  merchants(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/merchants", query);
  }
  orders(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/orders", query);
  }
  reservations(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/reservations", query);
  }
  reviews(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/reviews", query);
  }
  reports(query?: QueryParams): PagedRequest<Record<string, unknown>> {
    return this.paged<Record<string, unknown>>("/api/v1/admin/reports", query);
  }

  /** `GET /api/v1/admin/search/analytics`. */
  searchAnalytics(query?: QueryParams): Promise<Record<string, unknown>> {
    return this.reqGet("/api/v1/admin/search/analytics", query);
  }

  /** `POST /api/v1/admin/merchants/{id}/suspend`. */
  suspendMerchant(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/admin/merchants/${encodeURIComponent(id)}/suspend`, body ?? {});
  }

  /** `GET /api/v1/admin/system/health`. */
  systemHealth(): Promise<Record<string, unknown>> {
    return this.reqGet("/api/v1/admin/system/health");
  }
}
