/**
 * `POST /api/nexus/auth` — the one route the browser may hit to change its own session.
 *
 * The demo door (`POST /api/v1/auth/demo`) is deliberately narrow: it issues the account a fresh
 * deployment seeds and nothing else. It is the "local desk" a consumer or merchant reaches the
 * consoles from before §46/§48 login exists, and it is switched off by the platform flag
 * `nexus.demo.login-enabled=false` — so this route mirrors that switch rather than granting
 * anything the platform refuses.
 *
 * `DELETE` clears the two cookies issue-side; the platform's `/logout` requires a valid session,
 * so this route does not depend on one.
 *
 * Upstream Set-Cookie headers are forwarded unchanged (the platform already sets Path=/ and
 * HttpOnly for the session cookie and SameSite for both). Nothing from the body is filtered;
 * the body tells the client which identity the platform handed it, so the client can render
 * the right state.
 */
import { PLATFORM_BASE_URL, TENANT } from '@/lib/env';
import { SESSION_COOKIE } from '@/lib/env';

const ROLES = new Set(['consumer', 'merchant', 'admin']);
const PLATFORM_DEMO = `${PLATFORM_BASE_URL}/api/v1/auth/demo`;

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function envelope(code: string, message: string) {
  return { error: { code, message, request_id: null } };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requestIdFrom(headers: Headers): string | null {
  return headers.get('x-request-id') ?? headers.get('X-Request-Id') ?? null;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return json(envelope('validation_error', 'this route accepts JSON only'), 415);
    }
    body = await request.json();
  } catch {
    return json(envelope('validation_error', 'body must be valid JSON'), 422);
  }
  const role = (body as { role?: unknown })?.role;
  if (typeof role !== 'string' || !ROLES.has(role)) {
    return json(envelope('validation_error', 'role must be one of consumer|merchant|admin'), 422);
  }

  const upstream = await fetch(PLATFORM_DEMO, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-tenant': TENANT,
    },
    body: JSON.stringify({ role }),
    cache: 'no-store',
  }).catch(() => null);
  if (!upstream) {
    return json(envelope('internal', 'the platform is not reachable'), 502);
  }
  const requestId = requestIdFrom(upstream.headers);
  const text = await upstream.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(envelope('internal', 'invalid JSON from the platform'), 502);
    }
  }
  const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  const response = new Response(parsed === null ? null : JSON.stringify(parsed), {
    status: upstream.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
  });
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
}

export async function DELETE(_request: Request): Promise<Response> {
  const expired = [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    'nexus_csrf=; Path=/; Max-Age=0; SameSite=Lax',
  ];
  const response = new Response(JSON.stringify({ status: 'logged_out' }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  for (const cookie of expired) response.headers.append('set-cookie', cookie);
  return response;
}
