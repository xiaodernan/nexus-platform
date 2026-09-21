/**
 * The transport layer: single entry point every resource calls. Implements the
 * contract §1 conventions end to end — bearer/session auth injection, tenant and
 * locale headers, per-request `X-Request-Id` generation + propagation,
 * `Idempotency-Key` (generation, replay cache), per-request timeout via a
 * composed `AbortSignal`, retry with exponential backoff + jitter for safe /
 * idempotent requests only, `Retry-After` handling on 429, rate-limit header
 * capture, and error-envelope → {@link NexusApiError}.
 */
import { NexusApiError } from "./errors.js";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency.js";
import { resolveIdempotencyKey } from "./idempotency.js";
import type { HttpMethod, QueryParams } from "./types.js";
import {
  abortError,
  backoffDelay,
  buildQueryString,
  composeSignal,
  errorMessage,
  headersToRecord,
  parseRetryAfter,
  uuid,
} from "./util.js";

const SAFE_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);

export interface HttpInit {
  baseUrl: string;
  token?: string | undefined;
  apiKey?: string | undefined;
  tenant?: string | undefined;
  locale?: string | undefined;
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  fetch: typeof globalThis.fetch;
  idempotencyStore: IdempotencyStore;
  credentials: RequestCredentials;
  defaultHeaders: Record<string, string>;
}

export interface RequestSpec {
  method: HttpMethod;
  /** Path beginning with `/api/v1/...` or `/ai/v1/...`; appended to `baseUrl`. */
  path: string;
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  /** Attach auth headers. Defaults true. */
  auth?: boolean;
  /** Caller-supplied stable `Idempotency-Key`; enables the replay cache. */
  idempotencyKey?: string;
  /** Endpoint requires an Idempotency-Key (contract §1): auto-generate one if absent. */
  requireIdempotency?: boolean;
  /** Override whether a failed request may be retried. */
  safe?: boolean;
  /** Return the raw {@link Response} instead of parsed JSON (SSE / streaming). */
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

export interface PagedQuery {
  limit?: number;
  cursor?: string;
  [key: string]: QueryParams[string];
}

/** Mutable, per-request context that resources pass to `request`. */
export class HttpClient {
  constructor(private init: HttpInit) {}

  get baseUrl(): string {
    return this.init.baseUrl;
  }

  /** Swap the bearer token (e.g. after login/refresh) so later requests carry it. */
  setToken(token: string | undefined): void {
    this.init.token = token;
  }

  get hasToken(): boolean {
    return Boolean(this.init.token);
  }

  private buildUrl(spec: RequestSpec): string {
    const base = this.init.baseUrl.replace(/\/+$/, "");
    const path = spec.path.startsWith("/") ? spec.path : `/${spec.path}`;
    const extra = buildQueryString(withPageQuery(spec));
    return `${base}${path}${extra}`;
  }

  private buildHeaders(spec: RequestSpec, requestId: string): Headers {
    const h = new Headers(this.init.defaultHeaders);
    for (const [k, v] of Object.entries(spec.headers ?? {})) h.set(k, v);

    h.set("accept", spec.stream ? "text/event-stream" : "application/json");
    h.set("x-request-id", requestId);
    if (this.init.tenant) h.set("x-tenant", this.init.tenant);
    if (this.init.locale) h.set("accept-language", this.init.locale);

    if (spec.auth !== false) {
      if (this.init.token) h.set("authorization", `Bearer ${this.init.token}`);
      if (this.init.apiKey) h.set("x-api-key", this.init.apiKey);
    }
    return h;
  }

  /** Issue one logical request with idempotency + retry, returning parsed data or a stream. */
  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    const stream = spec.stream === true;
    const callerKey = typeof spec.idempotencyKey === "string" && spec.idempotencyKey.trim().length > 0 ? spec.idempotencyKey.trim() : undefined;
    const replayable = callerKey !== undefined && !stream;
    const idemKey = callerKey ?? (spec.requireIdempotency ? resolveIdempotencyKey() : undefined);
    const safe = spec.safe ?? (SAFE_METHODS.has(spec.method) || idemKey !== undefined);

    // 1. Idempotency replay cache: a completed response under this exact key is
    //    returned without touching the network, so a crash-retry cannot double-apply.
    if (replayable) {
      const cached = await this.init.idempotencyStore.get(callerKey!);
      if (cached) {
        if (cached.ok) return cached.body as T;
        throw NexusApiError.fromResponse({
          status: cached.status,
          body: cached.body,
          clientRequestId: cached.requestId,
        });
      }
    }

    const url = this.buildUrl(spec);
    const maxRetries = spec.retries ?? this.init.retries;
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const attemptTimeoutMs = spec.timeoutMs ?? this.init.timeoutMs;
    // One `X-Request-Id` for the whole logical request (survives retries), honoring a
    // per-request override first, then a client-level default, then generating fresh.
    const requestId = hset(spec.headers, "x-request-id") ?? hset(this.init.defaultHeaders, "x-request-id") ?? `req_${uuid()}`;

    for (let attempt = 0; ; attempt++) {
      const headers = this.buildHeaders(spec, requestId);
      if (idemKey) headers.set("idempotency-key", idemKey);
      const { signal, dispose } = composeSignal(spec.signal, attemptTimeoutMs);

      let res: Response;
      try {
        res = await this.init.fetch(url, {
          method: spec.method,
          headers,
          body,
          credentials: this.init.credentials,
          signal,
        } as RequestInitLike);
      } catch (err) {
        const callerAborted = spec.signal?.aborted === true;
        const reason = (signal as AbortSignal).reason as { name?: string } | undefined;
        const timedOut = reason?.name === "TimeoutError" || (err instanceof Error && (err.name === "TimeoutError" || (err.cause instanceof Error && err.cause.name === "TimeoutError")));
        dispose();
        // Caller-driven cancellation is never retried and is not a server failure.
        if (callerAborted) {
          throw NexusApiError.fromTransport(abortError(spec.signal), 0, requestId, "aborted");
        }
        // A per-request timeout is its own code (and is retryable for safe requests).
        const code = timedOut ? "timeout" : "network_error";
        const transport = NexusApiError.fromTransport(err, 0, requestId, code);
        if (safe && attempt < maxRetries) {
          await sleepRetry(backoffDelay(attempt, this.init.backoffBaseMs, this.init.backoffCapMs), spec.signal);
          continue;
        }
        throw transport;
      }

      const respRequestId = res.headers.get("x-request-id") ?? undefined;
      const rateLimit = pickRateLimit(headersToRecord(res.headers));
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after") ?? undefined);

      if (res.ok) {
        if (stream) {
          // Hand the live body back to the caller (no idempotency caching of streams).
          return res as unknown as T;
        }
        const data = await readJsonOrUndefined(res);
        if (replayable) {
          const record: IdempotencyRecord = { status: res.status, ok: true, body: data, createdAt: Date.now(), requestId };
          await this.init.idempotencyStore.set(callerKey!, record);
        }
        return data as T;
      }

      // Non-2xx: parse the error envelope.
      const errBody = await readJsonOrText(res);
      const error = NexusApiError.fromResponse({
        status: res.status,
        body: errBody,
        requestIdHeader: respRequestId,
        retryAfterMs,
        rateLimit,
        clientRequestId: requestId,
      });

      const retryableStatus = res.status === 429 || res.status >= 500;
      if (safe && retryableStatus && attempt < maxRetries) {
        // Honor Retry-After when the server gives it; otherwise exponential backoff + jitter.
        const wait = res.status === 429 && retryAfterMs !== undefined ? retryAfterMs : backoffDelay(attempt, this.init.backoffBaseMs, this.init.backoffCapMs);
        await sleepRetry(wait, spec.signal);
        continue;
      }

      // Terminal failure: cache 4xx (never auto-retried, safe to replay) but not 5xx
      // (could be transient — let a caller-supplied key retry).
      if (replayable && res.status >= 400 && res.status < 500) {
        await this.init.idempotencyStore.set(callerKey!, { status: res.status, ok: false, body: errBody, createdAt: Date.now(), requestId });
      }
      throw error;
    }
  }

  /** Issue a request and return the raw response (used by SSE + streaming downloads). */
  async raw(spec: RequestSpec): Promise<Response> {
    return this.request<Response>({ ...spec, stream: true });
  }
}

/** A response record type broadened to allow the extra fields we set on `fetch`. */
interface RequestInitLike {
  method: string;
  headers: Headers;
  body?: string;
  credentials: RequestCredentials;
  signal: AbortSignal;
}

function withPageQuery(spec: RequestSpec): QueryParams | undefined {
  // PagedQuery merging is handled by resource layer; here just pass through query.
  return spec.query;
}

function hset(headers: Record<string, string> | undefined, key: string): string | undefined {
  if (!headers) return undefined;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function pickRateLimit(rec: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
    if (rec[key] !== undefined) out[key] = rec[key]!;
  }
  return Object.keys(out).length ? out : undefined;
}

async function readJsonOrUndefined(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function sleepRetry(ms: number, signal?: AbortSignal): Promise<void> {
  const wait = Math.max(0, Math.round(ms));
  if (wait === 0) {
    if (signal?.aborted) throw abortError(signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(abortError(signal));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Surface the message for callers that catch and log. */
export function describeError(err: unknown): string {
  return errorMessage(err);
}
