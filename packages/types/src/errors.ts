/**
 * Error envelope.
 *
 * Contract: API_CONTRACT §1 "Error envelope (always)" — verbatim:
 * `{ "error": { "code": "merchant_not_found", "message": "...", "details": {}, "request_id": "..." } }`
 * with the code↔status table also in §1. Failure ladder in §1/§105 (LLM → fallback model →
 * deterministic search → human handoff) is surfaced through `ai_unavailable` + `details.fallback`.
 * Spec: §104 Reliability, §105 AI Failure Handling.
 */

import { ERROR_CODE_STATUS, RESOURCE_ERROR_SUFFIX } from "./enums.js";
import type { ResourceErrorSuffix } from "./enums.js";
import type { JsonObject } from "./common.js";

/** Error code name — API_CONTRACT §1. */
export type ApiErrorCode = keyof typeof ERROR_CODE_STATUS;

/**
 * A ladder code specialised by the resource that failed — `merchant_not_found`, `slot_not_found`,
 * `idempotency_key_conflict` (DECISIONS D27). Structurally the same statement as the `ResourceErrorCode`
 * branch of `src/schemas/error_envelope.json`.
 */
export type ResourceErrorCode = `${string}_${ResourceErrorSuffix}`;

/** Anything a service may put in `error.code`. */
export type WireErrorCode = ApiErrorCode | ResourceErrorCode;

/**
 * The §1 ladder code a wire code answers to, so a client can pick its rung without knowing the resource
 * (D27). Null for a string that is neither — `validation_failed`, `Not_Found` and a bare `notfound` are
 * all wire errors, and the caller must not guess a status for them.
 */
export function ladderErrorCode(code: string): ApiErrorCode | null {
  if (Object.prototype.hasOwnProperty.call(ERROR_CODE_STATUS, code)) return code as ApiErrorCode;
  for (const suffix of RESOURCE_ERROR_SUFFIX) {
    if (code.length > suffix.length + 1 && code.endsWith(`_${suffix}`)) {
      const resource = code.slice(0, code.length - suffix.length - 1);
      if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(resource)) return suffix;
    }
  }
  return null;
}

/** HTTP status a wire error code must be sent with; 500 when the code is not a contract code at all. */
export function errorHttpStatus(code: string): number {
  const ladder = ladderErrorCode(code);
  return ladder === null ? 500 : ERROR_CODE_STATUS[ladder];
}

/** HTTP status each error code must be sent with. Source: API_CONTRACT §1 table. */
export const ERROR_HTTP_STATUS = ERROR_CODE_STATUS;

/** All error codes, in the order documented in API_CONTRACT §1. */
export const ALL_ERROR_CODES = Object.keys(ERROR_CODE_STATUS) as ApiErrorCode[];

/**
 * The `error` object inside {@link ApiErrorEnvelope}.
 * **Source: API_CONTRACT §1.**
 *
 * Note on the §1 example: `"code": "merchant_not_found"` is *not* one of the eight codes the same
 * section enumerates. DECISIONS D27 settled it — the eight are the **status ladder**, and a code may
 * specialise `not_found|conflict|forbidden` by prefixing the resource name, so `code` accepts either
 * shape and the HTTP status is read off the suffix (`ladderErrorCode`). `details.resource` stays required
 * for a *bare* `not_found`, which names no subject. See CONTRACT NOTE 9 in `enums.ts`.
 */
export interface ApiError {
  /** Machine-readable code — API §1's ladder, optionally specialised by resource (DECISIONS D27). */
  code: WireErrorCode;
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
