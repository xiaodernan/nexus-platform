/**
 * Typed error surface. Every non-2xx response and every transport failure is
 * normalised into a {@link NexusApiError} that carries the contract's error
 * `code`, the HTTP `status`, optional `details`, the echoed `requestId` and —
 * on `rate_limited` — the parsed `retryAfterMs` plus rate-limit headers.
 */
import type { ErrorCode, ErrorEnvelope, Json } from "./types.js";
import { isPlainObject } from "./util.js";

/** Map a bare HTTP status to the contract's default code when the body omits one. */
export function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "validation_error";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 503:
      return "ai_unavailable";
    default:
      return status >= 500 ? "internal" : "internal";
  }
}

function extractErrorCode(body: unknown, status: number): { code: ErrorCode; message: string; details: Record<string, Json> | undefined; requestId: string | undefined } {
  if (isPlainObject(body) && isPlainObject(body.error)) {
    const env = body.error as Partial<ErrorEnvelope["error"]>;
    return {
      code: typeof env.code === "string" ? (env.code as ErrorCode) : statusToCode(status),
      message: typeof env.message === "string" && env.message.length ? env.message : `HTTP ${status}`,
      details: isPlainObject(env.details) ? (env.details as Record<string, Json>) : undefined,
      requestId: typeof env.request_id === "string" ? env.request_id : undefined,
    };
  }
  return {
    code: statusToCode(status),
    message: typeof body === "string" && body.length ? body : `HTTP ${status}`,
    details: undefined,
    requestId: undefined,
  };
}

/** Normalized NEXUS API error (contract §1 error envelope). */
export class NexusApiError extends Error {
  /** Stable machine code, e.g. `merchant_not_found`, `rate_limited`, `network_error`. */
  readonly code: ErrorCode;
  /** HTTP status, or `0` for transport failures (fetch threw / aborted). */
  readonly status: number;
  /** Server `details` object from the error envelope, if any. */
  readonly details?: Record<string, Json>;
  /** `request_id` from the envelope or the echoed `X-Request-Id` header. */
  readonly requestId?: string;
  /** `Retry-After` (ms) parsed from a 429/503, when present. */
  readonly retryAfterMs?: number;
  /** Rate-limit headers captured from the response (`X-RateLimit-Remaining`, …). */
  readonly rateLimit?: Record<string, string>;
  /** The `X-Request-Id` this client generated for the failed attempt. */
  readonly clientRequestId?: string;
  /** The underlying cause for transport failures (AbortError, TypeError, …). */
  override readonly cause?: unknown;

  constructor(
    init: {
      code: ErrorCode;
      status: number;
      message: string;
      details?: Record<string, Json>;
      requestId?: string;
      retryAfterMs?: number;
      rateLimit?: Record<string, string>;
      clientRequestId?: string;
      cause?: unknown;
    },
  ) {
    super(init.message);
    this.name = "NexusApiError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.rateLimit = init.rateLimit;
    this.clientRequestId = init.clientRequestId;
    this.cause = init.cause;
    // Restore prototype chain for transpile-to-older-target safety.
    Object.setPrototypeOf(this, NexusApiError.prototype);
  }

  /** True when the request never completed against the server (network/abort/timeout). */
  get isTransportError(): boolean {
    return this.status === 0;
  }

  /** Build an error from a parsed response body + status + echoed headers. */
  static fromResponse(opts: {
    status: number;
    body: unknown;
    requestIdHeader?: string | null;
    retryAfterMs?: number;
    rateLimit?: Record<string, string>;
    clientRequestId?: string;
  }): NexusApiError {
    const { code, message, details, requestId } = extractErrorCode(opts.body, opts.status);
    return new NexusApiError({
      code,
      status: opts.status,
      message,
      details,
      requestId: requestId ?? (opts.requestIdHeader ?? undefined),
      retryAfterMs: opts.retryAfterMs,
      rateLimit: opts.rateLimit,
      clientRequestId: opts.clientRequestId,
    });
  }

  /** Build an error for a transport failure (fetch rejected). */
  static fromTransport(err: unknown, status: number, clientRequestId?: string, codeOverride?: ErrorCode): NexusApiError {
    const inferred =
      codeOverride ??
      (err instanceof Error && (err.name === "TimeoutError" || (err.cause instanceof Error && err.cause.name === "TimeoutError"))
        ? "timeout"
        : err instanceof Error && err.name === "AbortError"
          ? "aborted"
          : "network_error");
    return new NexusApiError({
      code: inferred,
      status,
      message: err instanceof Error ? err.message : String(err),
      clientRequestId,
      cause: err,
    });
  }
}
