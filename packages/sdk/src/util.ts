/**
 * Environment-agnostic helpers. No Node-only or browser-only globals are used
 * without a guarded fallback, so the compiled output runs on both (DECISIONS D1:
 * Node 24 + browser, ESM).
 */
import type { Json, QueryParams } from "./types.js";

/** Best-effort RFC-4122 v4 id, preferring the platform's `crypto.randomUUID`. */
export function uuid(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  // Fallback for exotic runtimes without WebCrypto.
  const bytes = new Uint8Array(16);
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fresh `X-Request-Id` for a logical request (contract §1). */
export function newRequestId(): string {
  return `req_${uuid()}`;
}

/** Fresh `Idempotency-Key` when a caller did not supply one (contract §1). */
export function newIdempotencyKey(): string {
  return `idem_${uuid()}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const clamped = Math.max(0, ms);
  if (clamped === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, clamped);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Full-jitter exponential backoff (AWS "full jitter"), capped. Returns ms to wait. */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.random() * exp;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or `undefined`. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Serialise query params: repeats arrays, coerces scalars, drops `undefined`, flags `null` as bare. */
export function buildQueryString(params?: QueryParams): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item === undefined) continue;
        usp.append(key, item === null ? "" : item instanceof Date ? item.toISOString() : String(item));
      }
      continue;
    }
    const value = raw === null ? "" : raw instanceof Date ? raw.toISOString() : String(raw);
    usp.append(key, value);
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build an `Error` (shaped like DOMException.AbortError) from an aborted signal. */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal && "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Compose a per-attempt abort signal from an optional caller signal and an
 * optional timeout, without leaking timers. Node 24 + modern browsers expose
 * `AbortSignal.any`/`AbortSignal.timeout`; fall back to a manual controller.
 */
export function composeSignal(callerSignal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; dispose: () => void } {
  const timeoutSignal = timeoutMs && timeoutMs > 0 && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;

  if (typeof AbortSignal.any === "function" && callerSignal && timeoutSignal) {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), dispose: () => {} };
  }

  if (typeof AbortSignal.any === "function") {
    const sources = [callerSignal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s));
    if (sources.length === 1) return { signal: sources[0]!, dispose: () => {} };
    if (sources.length > 1) return { signal: AbortSignal.any(sources), dispose: () => {} };
  }

  // Manual path (older runtimes): own controller bridging both inputs.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason ?? abortError(callerSignal));
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      controller.abort(err);
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Coerce unknown thrown values into a readable message for `degraded` reasons. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

export function isRecord(value: unknown): value is Record<string, Json | unknown> {
  return isPlainObject(value);
}
