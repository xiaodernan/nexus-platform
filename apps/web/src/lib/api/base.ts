import { AI_BASE_URL, BFF_TIMEOUT_MS, PLATFORM_BASE_URL, TENANT } from '../env';
import type { ApiErrorEnvelope } from '../types';

/**
 * The single HTTP escape hatch of apps/web. Nothing else may call `fetch` on a service origin:
 *  - server components/actions call `platformFetch` / `aiFetch` (via lib/api/*.ts);
 *  - the browser calls the BFF at `/api/nexus/**`, which forwards here with tenant + auth (§0).
 *
 * Errors are normalised into `NexusApiError` carrying the §1 envelope code, so every page can
 * render the same ErrorState regardless of which service failed.
 */

export class NexusApiError extends Error {
  readonly status: number;
  readonly code: string;
  requestId: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    opts: { status?: number; code?: string; requestId?: string | null; details?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = 'NexusApiError';
    this.status = opts.status ?? 500;
    this.code = opts.code ?? 'internal';
    this.requestId = opts.requestId ?? null;
    this.details = opts.details ?? null;
  }

  /** True when the failure is "the model is unavailable" — the UI must keep working (§105). */
  get isAiUnavailable(): boolean {
    return this.code === 'ai_unavailable' || this.status === 503;
  }

  toJSON() {
    return { code: this.code, message: this.message, status: this.status, request_id: this.requestId };
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Cookies to forward (session + CSRF) — server side only, never logged. */
  cookieHeader?: string | null;
  authorization?: string | null;
  idempotencyKey?: string | null;
  searchParams?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  tenant?: string;
  /** Set when the caller knows the response body is a stream (BFF passes it through raw). */
  raw?: boolean;
  cache?: RequestCache;
  signal?: AbortSignal;
}

function buildUrl(base: string, path: string, searchParams?: RequestOptions['searchParams']): string {
  const url = new URL(path, base);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function requestIdFrom(headers: Headers): string | null {
  return headers.get('x-request-id') ?? headers.get('X-Request-Id') ?? null;
}

async function normaliseError(response: Response): Promise<NexusApiError> {
  const requestId = requestIdFrom(response.headers);
  let code = 'internal';
  let message = response.statusText || 'request_failed';
  let details: Record<string, unknown> | null = null;
  try {
    const payload = (await response.json()) as ApiErrorEnvelope;
    if (payload?.error) {
      code = payload.error.code ?? code;
      message = payload.error.message ?? message;
      details = (payload.error.details as Record<string, unknown> | null) ?? null;
    }
  } catch {
    // Non-JSON error body (proxy/gateway): keep the status-derived code.
    code =
      response.status === 404
        ? 'not_found'
        : response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 422
              ? 'validation_error'
              : response.status === 429
                ? 'rate_limited'
                : response.status === 503
                  ? 'ai_unavailable'
                  : 'internal';
  }
  return new NexusApiError(message, { status: response.status, code, requestId, details });
}

/**
 * Core request. `target` chooses platform (:8090) or AI (:8010) — D9's canonical local ports behind
 * documented env vars, and the only two origins this app can reach.
 */
export async function nexusFetch<T>(
  target: 'platform' | 'ai',
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; requestId: string | null; demo: boolean }> {
  const base = target === 'ai' ? AI_BASE_URL : PLATFORM_BASE_URL;
  const url = buildUrl(base, path, options.searchParams);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('upstream_timeout')), options.timeoutMs ?? BFF_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort(new Error('client_abort'));
  options.signal?.addEventListener('abort', onOuterAbort);

  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-tenant': options.tenant ?? TENANT,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookieHeader) headers.cookie = options.cookieHeader;
  if (options.authorization) headers.authorization = `Bearer ${options.authorization}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  // CSRF is only meaningful for state-changing cookie requests (§1).
  if (options.cookieHeader && options.method && options.method !== 'GET') {
    const csrf = /(?:^|;\s*)nexus_csrf=([^;]+)/.exec(options.cookieHeader)?.[1];
    if (csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: options.cache ?? (options.method && options.method !== 'GET' ? 'no-store' : 'default'),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = (cause as Error)?.name === 'AbortError';
    throw new NexusApiError(aborted ? 'upstream_timeout' : 'upstream_unreachable', {
      status: aborted ? 504 : 502,
      code: aborted ? 'internal' : 'internal',
      details: { target, path, cause: String(cause) },
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const requestId = requestIdFrom(response.headers);
  const demo = response.headers.get('x-demo-data') === 'true';

  if (!response.ok) {
    const error = await normaliseError(response);
    if (!error.requestId) error.requestId = requestId;
    throw error;
  }

  if (options.raw) return { data: response as unknown as T, requestId, demo };
  if (response.status === 204) return { data: null as T, requestId, demo };

  const text = await response.text();
  if (!text) return { data: null as T, requestId, demo };
  try {
    return { data: JSON.parse(text) as T, requestId, demo };
  } catch {
    throw new NexusApiError('invalid_json_from_upstream', { status: 502, code: 'internal', requestId });
  }
}

/**
 * Convenience GET read for the many GETs that only need the body. It never *forces* GET: when a
 * caller passes a `method` (POST/PATCH/DELETE) and a `body` — which `lib/data`'s live reads do for
 * the AI search/compare endpoints — that verb is honoured. Defaulting to GET is only for bare GET
 * callers; pinning `method:'GET'` while a body is present would make undici reject the request
 * ("Request with GET/HEAD method cannot have body") and surface a real read as `upstream_unreachable`.
 */
export async function nexusGet<T>(target: 'platform' | 'ai', path: string, options?: RequestOptions): Promise<T> {
  const { data } = await nexusFetch<T>(target, path, { method: 'GET', ...options });
  return data;
}
