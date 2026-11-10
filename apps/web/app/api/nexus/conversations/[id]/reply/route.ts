/**
 * `POST /api/nexus/conversations/{id}/reply` — a human team member answers in the thread (§142).
 *
 * This is the return half of the loop `ask` opens: the consumer perguntou through the BFF, the
 * merchant-agent answered from the merchant's own KB, and now the merchant takes the conversation
 * over — see `api/v1/conversations/{id}/reply` on the platform, which stamps the thread
 * `merchant_user` (role `assistant`), flips the mode to `hybrid` once both have spoken, records an
 * audit row, and publishes a `HandoffResolved`.
 *
 * RBAC is the platform's: the cookie this BFF forwards is the merchant team member's own session, and
 * `@RequiresPermission(value = "send_message", merchant = "conversation:id")` lets only members of
 * the thread's merchant answer it. Anyone else gets the platform's 403 straight through.
 *
 * Mock mode answers 501 instead of faking a send: a reply the merchant believes in is exactly the
 * thing that must not silently vanish. The console never renders this in mock mode either (the
 * composer is suppressed on demo-origin threads).
 */

import { cookies } from 'next/headers';

import { CSRF_COOKIE, IS_MOCK, SESSION_COOKIE } from '@/lib/env';
import { NexusApiError, nexusFetch } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LENGTH = 2000;

function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, details: null, request_id: null } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return errorEnvelope(422, 'validation_error', 'conversation id must be a uuid');
  }

  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const csrf = jar.get(CSRF_COOKIE)?.value;
  if (!session) {
    return errorEnvelope(401, 'unauthorized', 'sign in as the merchant to reply');
  }
  if (IS_MOCK) {
    return errorEnvelope(501, 'not_implemented', 'mock mode never sends a merchant reply');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorEnvelope(422, 'validation_error', 'body must be valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    return errorEnvelope(422, 'validation_error', 'body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return errorEnvelope(422, 'validation_error', 'content is required');
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    return errorEnvelope(422, 'validation_error', `content must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }

  const cookieHeader = `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf ?? ''}`;
  try {
    const { data } = await nexusFetch<Record<string, unknown>>(
      'platform',
      `/api/v1/conversations/${encodeURIComponent(id)}/reply`,
      { method: 'POST', cookieHeader, body: { content, content_type: 'text' } },
    );
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (cause) {
    if (cause instanceof NexusApiError) {
      return errorEnvelope(cause.status, cause.code, cause.message);
    }
    return errorEnvelope(502, 'internal', 'the platform is not reachable');
  }
}
