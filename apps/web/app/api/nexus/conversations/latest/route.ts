/**
 * `GET /api/nexus/conversations/latest?merchant_id=<uuid>` — the caller's most recent thread with
 * one merchant, with its messages, for the ask-merchant widget (§142's consumer half).
 *
 * One round trip: the BFF lists the caller's threads (`GET /api/v1/conversations?merchant_id=…`,
 * the RBAC-gated owner read — the platform only ever returns the caller's own threads), then reads
 * the newest thread's messages through the same-owner conversation door
 * (`GET /api/v1/conversations/{id}`). Never anyone else's thread.
 *
 * Status codes the client understands:
 *   200 `{ "conversation": null }`              — signed-in consumer with no thread here yet
 *   200 `{ "conversation_id": ..., "messages": [ ... ], "status": ..., "mode": ... }`
 *   401 `unauthorized`                          — anonymous viewer; the widget paints the CTA, not an error
 *   422 `validation_error`                      — `merchant_id` not a uuid
 *   404 `conversation_not_found`                — thread exists but the caller cannot read it (D5: 404, never 403)
 */

import { cookies } from 'next/headers';

import { IS_MOCK, SESSION_COOKIE, CSRF_COOKIE } from '@/lib/env';
import { NexusApiError, nexusFetch } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, details: null, request_id: null } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const merchantId = url.searchParams.get('merchant_id') ?? '';
  if (!UUID_RE.test(merchantId)) {
    return errorEnvelope(422, 'validation_error', 'merchant_id must be a uuid');
  }

  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const csrf = jar.get(CSRF_COOKIE)?.value;
  if (!session) {
    return errorEnvelope(401, 'unauthorized', 'sign in to see your conversation');
  }
  if (IS_MOCK) {
    return Response.json({ conversation: null });
  }

  const cookieHeader = `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf ?? ''}`;

  let listed: Record<string, unknown> | null = null;
  try {
    const result = await nexusFetch<Record<string, unknown>>(
      'platform',
      `/api/v1/conversations?merchant_id=${encodeURIComponent(merchantId)}&limit=1`,
      { cookieHeader },
    );
    listed = result.data as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof NexusApiError && cause.status === 401) {
      return errorEnvelope(401, 'unauthorized', 'sign in to see your conversation');
    }
    return errorEnvelope(502, 'internal', 'the platform is not reachable');
  }

  const items = Array.isArray(listed?.items) ? (listed!.items as Array<Record<string, unknown>>) : [];
  const latest = items[0];
  if (!latest) {
    return Response.json({ conversation: null });
  }
  const id = typeof latest.id === 'string' ? latest.id : null;
  if (!id) {
    return errorEnvelope(502, 'internal', 'the platform returned a thread without an id');
  }

  let thread: Record<string, unknown> | null = null;
  try {
    const result = await nexusFetch<Record<string, unknown>>(
      'platform',
      `/api/v1/conversations/${encodeURIComponent(id)}`,
      { cookieHeader },
    );
    thread = result.data as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof NexusApiError && (cause.status === 401 || cause.status === 404)) {
      return errorEnvelope(cause.status, cause.code, cause.message);
    }
    return errorEnvelope(502, 'internal', 'the platform is not reachable');
  }

  const conversation = (thread?.conversation as Record<string, unknown> | undefined) ?? thread;
  const messages = Array.isArray(conversation?.messages)
    ? conversation!.messages
    : Array.isArray(thread?.messages)
      ? (thread!.messages as unknown)
      : [];

  return Response.json(
    {
      conversation_id: id,
      status: conversation?.status ?? null,
      mode: conversation?.mode ?? null,
      messages,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
