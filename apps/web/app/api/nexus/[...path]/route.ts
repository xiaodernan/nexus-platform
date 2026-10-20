/**
 * `ANY /api/nexus/{platform|ai}/...` — the general BFF proxy for everything that is not the search
 * stream. The browser never learns a service origin, a session token or a tenant header; this route
 * is where those are attached (§0, §1).
 *
 * Two rules are enforced here rather than trusted at call sites:
 *  1. §7.0 service-to-service paths are unreachable through the BFF, so a stolen browser session
 *     cannot post agent turns or extraction jobs to the platform's internal door.
 *  2. Upstream failures are re-emitted as the §1 error envelope with the upstream status preserved,
 *     so `ErrorState` can render a real code instead of an opaque proxy 500.
 */

import { nexusFetch, NexusApiError } from '@/lib/api/base';
import { IS_MOCK, TENANT } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** §7.0: never browser-reachable, matched on the decoded path so `%69nternal` cannot slip through. */
const BLOCKED = [/\/internal\//, /(^|\/)imports\/extract/, /(^|\/)internal$/];

function json(value: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  });
}

function errorEnvelope(code: string, message: string, requestId: string | null, details?: Record<string, unknown> | null) {
  return { error: { code, message, details: details ?? null, request_id: requestId } };
}

interface ProxyTarget {
  service: 'platform' | 'ai';
  /** Path as the upstream service expects it, e.g. `/api/v1/me/favorites`. */
  path: string;
}

/** `/api/nexus/platform/me/favorites` → platform `/api/v1/me/favorites`. */
function resolve(segments: string[]): ProxyTarget | null {
  const [service, ...rest] = segments;
  const tail = `/${rest.map((segment) => decodeURIComponent(segment)).join('/')}`;
  if (service === 'platform') return { service: 'platform', path: `/api/v1${tail}` };
  if (service === 'ai') return { service: 'ai', path: `/ai/v1${tail}` };
  return null;
}

async function proxy(request: Request, segments: string[]): Promise<Response> {
  const target = resolve(segments);
  if (!target) {
    return json(errorEnvelope('not_found', 'unknown BFF prefix: expected /api/nexus/platform/… or /api/nexus/ai/…', null), 404);
  }
  if (BLOCKED.some((pattern) => pattern.test(target.path))) {
    return json(errorEnvelope('forbidden', 'this endpoint is service-to-service only (§7.0)', null), 403);
  }
  if (IS_MOCK) {
    return json(
      errorEnvelope('data_mode_mock', 'NEXT_PUBLIC_DATA_MODE=mock serves pages from fixtures; set it to live to proxy /api/nexus/**', null),
      501,
    );
  }

  // Only the four verbs the contract defines are exported, so Next answers anything else itself.
  const method = request.method as 'GET' | 'POST' | 'PATCH' | 'DELETE';

  let body: unknown;
  if (method !== 'GET') {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return json(errorEnvelope('validation_error', 'this proxy accepts JSON request bodies only', null), 415);
    }
    try {
      body = await request.json();
    } catch {
      return json(errorEnvelope('validation_error', 'body must be valid JSON', null), 422);
    }
  }

  try {
    const result = await nexusFetch<TargetResponse>(target.service, target.path, {
      method,
      body,
      cookieHeader: target.service === 'platform' ? request.headers.get('cookie') : null,
      idempotencyKey: request.headers.get('idempotency-key'),
      searchParams: Object.fromEntries(new URL(request.url).searchParams),
      tenant: TENANT,
      raw: true,
    });
    const upstream = result.data;
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        ...(upstream.headers.get('x-demo-data') ? { 'x-demo-data': 'true' } : {}),
        ...(upstream.headers.get('x-nexus-degraded') ? { 'x-nexus-degraded': upstream.headers.get('x-nexus-degraded') as string } : {}),
        ...(result.requestId ? { 'x-request-id': result.requestId } : {}),
      },
    });
  } catch (cause) {
    if (cause instanceof NexusApiError) {
      return json(errorEnvelope(cause.code, cause.message, cause.requestId, cause.details), cause.status);
    }
    return json(errorEnvelope('internal', cause instanceof Error ? cause.message : 'proxy_failed', null), 500);
  }
}

/** `raw: true` hands back the upstream Response; this is the slice of it the proxy touches. */
interface TargetResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
