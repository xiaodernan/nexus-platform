/**
 * Error envelope.
 *
 * Contract: API_CONTRACT §1 "Error envelope (always)" — verbatim:
 * `{ "error": { "code": "merchant_not_found", "message": "...", "details": {}, "request_id": "..." } }`
 * with the code↔status table also in §1. Failure ladder in §1/§105 (LLM → fallback model →
 * deterministic search → human handoff) is surfaced through `ai_unavailable` + `details.fallback`.
 * Spec: §104 Reliability, §105 AI Failure Handling.
 */

import { ERROR_CODE_STATUS } from "./enums.js";
import type { JsonObject } from "./common.js";

/** Error code name — API_CONTRACT §1. */
export type ApiErrorCode = keyof typeof ERROR_CODE_STATUS;

/** HTTP status each error code must be sent with. Source: API_CONTRACT §1 table. */
export const ERROR_HTTP_STATUS = ERROR_CODE_STATUS;

/** All error codes, in the order documented in API_CONTRACT §1. */
export const ALL_ERROR_CODES = Object.keys(ERROR_CODE_STATUS) as ApiErrorCode[];

/**
 * The `error` object inside {@link ApiErrorEnvelope}.
 * **Source: API_CONTRACT §1.**
 *
 * Note on the §1 example: `"code": "merchant_not_found"` is *not* one of the eight codes the same
 * section enumerates. The enumeration is treated as the closed `code` domain and the example value
 * is modelled as `details.resource` + `details.reason` (see CONTRACT NOTES in `enums.ts`); the
 * JSON Schema therefore constrains `code` to the eight documented values.
 */
export interface ApiError {
  /** Machine-readable code — API §1 (`validation_error|unauthorized|forbidden|not_found|conflict|rate_limited|ai_unavailable|internal`). */
  code: ApiErrorCode;
  /** Human-readable, localised message (AGENT §12: echo the user's locale). Never a stack trace. */
  message: string;
  /** Structured context: field errors, resource/reason, retry hints. Keys snake_case. */
  details: JsonObject;
  /** Correlation id echoed from `X-Request-Id` — API §1 "attached to logs, agent_runs, audit_logs". */
  request_id: string | null;
  /** Optional per-field validation errors, when `code` is `validation_error`. */
  field_errors?: Record<string, string>;
}

/**
 * Top-level error body sent on every non-2xx response. **Source: API_CONTRACT §1.**
 * `details.retry_after` carries the seconds from the `Retry-After` header for `rate_limited`
 * (API §1 rate limits).
 */
export interface ApiErrorEnvelope {
  /** The error object — the only top-level key on an error response (API §1 "always"). */
  error: ApiError;
}

/** Convenience: an `ApiErrorEnvelope` narrowed to one code. */
export type ApiErrorOf<C extends ApiErrorCode> = ApiErrorEnvelope & { error: { code: C } };

/**
 * `details` shape for `validation_error` (422) — produced by both platform (Spring bean
 * validation) and AI (Pydantic) services; `location` follows the JSON-Pointer-ish path style.
 */
export interface ValidationErrorDetails {
  /** Failing fields keyed by path, e.g. `intent.budget.max`. */
  fields?: Record<string, string>;
  /** Schema id the payload was validated against — `src/schemas/*.json` `$id`. */
  schema?: string;
  /** Structured validator errors. */
  errors?: Array<{ path: string; keyword: string; message: string }>;
}

/** `details` shape for `rate_limited` (429) — API_CONTRACT §1 (`Retry-After` + `X-RateLimit-Remaining`). */
export interface RateLimitDetails {
  /** Seconds to wait before retrying — mirrors the `Retry-After` header. */
  retry_after: number;
  /** Remaining quota — mirrors `X-RateLimit-Remaining`. */
  remaining: number;
  /** Quota window in seconds. */
  window_s?: number;
  /** Limit the caller is over. */
  limit?: number;
  /** Scope key the bucket is charged to — V1 `rate_limit_buckets.key`. */
  bucket?: string;
}

/** `details` shape for `ai_unavailable` (503) — the failure ladder in API §1 / spec §105. */
export interface AiUnavailableDetails {
  /** Which ladder rung failed (`llm|rerank|retrieval|agent`). */
  stage: string;
  /** Fallback the caller should use; `/ai/v1/search` is the deterministic rung (API §7). */
  fallback: "model_fallback" | "deterministic_search" | "human" | string;
  /** Whether the caller can simply retry. */
  retryable: boolean;
  /** Agent that gave up — AGENT §1 roster. */
  agent?: string | null;
  /** Run id for the observability trail — V1 `agent_runs.id`. */
  agent_run_id?: string | null;
}

/** Type guard used by BFF/error boundaries: is this the §1 envelope? */
export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { error?: unknown };
  if (typeof candidate.error !== "object" || candidate.error === null) return false;
  const err = candidate.error as { code?: unknown; message?: unknown };
  return typeof err.code === "string" && typeof err.message === "string";
}
