/**
 * `merchant` — the tenant + RBAC-gated merchant workspace (contract §5). Roles
 * come from `merchant_users`; the server enforces the required permission per
 * route. The SDK only carries the caller's credential — it never elevates or
 * bypasses a permission check (DECISIONS D6 / AGENT_CONTRACT §8).
 *
 * Campaign publishing is deliberately an explicit human action: `campaigns.approvePublish`
 * is the only path that publishes and it requires an Idempotency-Key — AI-drafted
 * campaigns stay in `draft` until a merchant calls it (§27).
 */
import { Resource } from "./_base.js";
import { NexusApiError } from "../errors.js";
import type { Page, QueryParams } from "../types.js";
import { sleep } from "../util.js";

export interface ImportSource {
  type: "url" | "text" | "file";
  value: string;
}

export interface CreateImportInput {
  merchant_id: string;
  source?: ImportSource;
  files?: Array<{ name: string; content_base64: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ImportProposal {
  offering_draft: Record<string, unknown>;
  evidence_fact_ids: string[];
  confidence: number;
  [key: string]: unknown;
}

export interface ImportJob {
  job_id: string;
  status: "queued" | "running" | "done" | "completed" | "failed" | "partial" | string;
  proposals?: ImportProposal[];
  error?: string;
  [key: string]: unknown;
}

class BusinessesResource extends Resource {
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/businesses", body);
  }
  update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.patch(`/api/v1/merchant/businesses/${encodeURIComponent(id)}`, body);
  }
  /** `POST /{id}/verification` — requests verification (never auto-verifies). */
  verify(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchant/businesses/${encodeURIComponent(id)}/verification`, body ?? {});
  }
  /** `POST /{id}/publish` — merchant's explicit publish action. */
  publish(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchant/businesses/${encodeURIComponent(id)}/publish`, body ?? {});
  }
}

class OfferingsResource extends Resource {
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/offerings", body);
  }
  update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.patch(`/api/v1/merchant/offerings/${encodeURIComponent(id)}`, body);
  }
  remove(id: string): Promise<void> {
    return this.del(`/api/v1/merchant/offerings/${encodeURIComponent(id)}`);
  }
  /** `POST /api/v1/merchant/offerings/bulk`. */
  bulk(body: { merchant_id?: string; items: Array<Record<string, unknown>> }): Promise<unknown> {
    return this.post("/api/v1/merchant/offerings/bulk", body);
  }
}

class ImportsResource extends Resource {
  /** `POST /api/v1/merchant/imports` → `202 {job_id, status:"queued"}` (§5.1). */
  create(body: CreateImportInput): Promise<ImportJob> {
    return this.post<ImportJob>("/api/v1/merchant/imports", body);
  }
  /** `GET /api/v1/merchant/imports/{job_id}` — poll for `proposals` (nothing publishes without review). */
  get(jobId: string): Promise<ImportJob> {
    return super.reqGet<ImportJob>(`/api/v1/merchant/imports/${encodeURIComponent(jobId)}`);
  }

  /**
   * Poll an import until terminal (`done`/`completed`/`failed`/`partial`).
   * Aborts on caller `signal` or `timeoutMs`. This mirrors the documented async
   * pipeline (crawl → parse → clean → chunk → embed → classify → proposals).
   */
  async wait(jobId: string, opts?: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ImportJob> {
    const pollMs = opts?.pollMs ?? 1000;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.get(jobId);
      const terminal = job.status === "done" || job.status === "completed" || job.status === "failed" || job.status === "partial";
      if (terminal) return job;
      if (opts?.signal?.aborted) throw new NexusApiError({ code: "aborted", status: 0, message: "import wait aborted" });
      if (Date.now() + pollMs > deadline) {
        return job; // non-terminal but out of time — surface the last known state, do not hang
      }
      await sleep(pollMs, opts?.signal);
    }
  }
}

class MembersResource extends Resource {
  list(): Promise<Page<Record<string, unknown>> | Array<Record<string, unknown>>> {
    return this.reqGet("/api/v1/merchant/members");
  }
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/members", body);
  }
  update(memberId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.patch(`/api/v1/merchant/members/${encodeURIComponent(memberId)}`, body);
  }
  remove(memberId: string): Promise<void> {
    return this.del(`/api/v1/merchant/members/${encodeURIComponent(memberId)}`);
  }
}

class ApiKeysResource extends Resource {
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/api-keys", body);
  }
  remove(id: string): Promise<void> {
    return this.del(`/api/v1/merchant/api-keys/${encodeURIComponent(id)}`);
  }
}

class DashboardResource extends Resource {
  overview(query?: QueryParams): Promise<Record<string, unknown>> {
    return this.reqGet("/api/v1/merchant/dashboard/overview", query);
  }
}

class AnalyticsResource extends Resource {
  get(query?: { from?: string; to?: string; metric?: string }): Promise<Record<string, unknown>> {
    return super.reqGet("/api/v1/merchant/analytics", query);
  }
}

class CampaignsResource extends Resource {
  /** `POST /api/v1/merchant/campaigns` — AI-drafted campaigns land in `draft`. */
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/campaigns", body);
  }
  /**
   * `POST /api/v1/merchant/campaigns/{id}/approve-publish` — explicit human
   * action (§27). Requires an Idempotency-Key (auto-generated unless provided).
   */
  approvePublish(id: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchant/campaigns/${encodeURIComponent(id)}/approve-publish`, body ?? {}, {
      requireIdempotency: true,
      idempotencyKey,
    });
  }
}

class CouponsResource extends Resource {
  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/coupons", body);
  }
}

class KnowledgeBaseResource extends Resource {
  list(query?: QueryParams): Promise<unknown> {
    return this.reqGet("/api/v1/merchant/knowledge-base", query);
  }
  reindex(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/knowledge-base/reindex", body ?? {});
  }
}

class WorkspaceConversationsResource extends Resource {
  list(query?: QueryParams): Promise<unknown> {
    return this.reqGet("/api/v1/merchant/conversations", query);
  }
  reply(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchant/conversations/${encodeURIComponent(id)}/reply`, body);
  }
  resolveHandoff(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/merchant/conversations/${encodeURIComponent(id)}/handoff-resolve`, body ?? {});
  }
}

export class MerchantWorkspaceResource extends Resource {
  // Derived-class field initializers run after `super(http)`, so `this.http` is set.
  readonly businesses = new BusinessesResource(this.http);
  readonly offerings = new OfferingsResource(this.http);
  readonly imports = new ImportsResource(this.http);
  readonly members = new MembersResource(this.http);
  readonly apiKeys = new ApiKeysResource(this.http);
  readonly dashboard = new DashboardResource(this.http);
  readonly analytics = new AnalyticsResource(this.http);
  readonly campaigns = new CampaignsResource(this.http);
  readonly coupons = new CouponsResource(this.http);
  readonly knowledgeBase = new KnowledgeBaseResource(this.http);
  readonly conversations = new WorkspaceConversationsResource(this.http);

  /** `POST /api/v1/merchant/ai-agent/config` (permission `configure_ai`). */
  setAiAgentConfig(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/v1/merchant/ai-agent/config", body);
  }

  /** `GET /api/v1/merchant/export` — the merchant owns their data (§107). */
  export(query?: QueryParams): Promise<unknown> {
    return this.reqGet("/api/v1/merchant/export", query);
  }
}
