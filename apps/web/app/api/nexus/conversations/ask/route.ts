/**
 * `POST /api/nexus/conversations/ask` — one consumer question to one merchant (§142).
 *
 * Two services are involved and neither may be called from the browser (§0):
 *
 *  1. the platform opens (or re-opens) the thread the question belongs to. `POST /api/v1/conversations`
 *     is `@RequiresAuth`, so this route is the point where "signed out" becomes a 401 the UI can act
 *     on instead of a dead textarea;
 *  2. the AI answers from that merchant's knowledge base at `POST /ai/v1/merchant-agent/chat` and
 *     relays both turns back through the platform's audited internal door (D846), so the thread the
 *     merchant inbox reads is the same thread this route opened.
 *
 * The answer is forwarded byte-for-byte: `status`/`summary`/`done`/`error` are the contract's events
 * (AGENT_CONTRACT §7), and this proxy holds no opinion about them.
 *
 * Mock mode (`DATA_MODE=mock`) answers locally and writes nothing. It does NOT require a session
 * because it cannot persist, authorise or charge anything — the offline review stays reviewable
 * (§105/§641), and the answer says plainly that it is a demo (§155).
 */

import { cookies } from 'next/headers';
import { nexusFetch, NexusApiError } from '@/lib/api/base';
import { AI_INTERNAL_TIMEOUT_MS, CSRF_COOKIE, IS_MOCK, SESSION_COOKIE } from '@/lib/env';
import { getDict, normalizeLocale } from '@/lib/i18n';
import { SEED_MERCHANTS } from '@/lib/mock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LENGTH = 500;
const MOCK_PREFIX = 'mock-conv-';

interface AskRequestBody {
  merchant_id: string;
  merchant_slug: string | null;
  message: string;
  conversation_id: string | null;
  locale: string;
}

function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, details: null, request_id: null } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

function sseHeaders(conversationId: string): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-conversation-id': conversationId,
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseBody(value: unknown): AskRequestBody | string {
  if (typeof value !== 'object' || value === null) return 'body must be a JSON object';
  const body = value as Record<string, unknown>;
  const merchantId = typeof body.merchant_id === 'string' ? body.merchant_id.trim() : '';
  if (!merchantId) return 'merchant_id is required';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return 'message is required';
  if (message.length > MAX_MESSAGE_LENGTH) return `message must be at most ${MAX_MESSAGE_LENGTH} characters`;
  const conversationId =
    typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : null;
  const merchantSlug = typeof body.merchant_slug === 'string' && body.merchant_slug ? body.merchant_slug : null;
  return {
    merchant_id: merchantId,
    merchant_slug: merchantSlug,
    message,
    conversation_id: conversationId,
    locale: normalizeLocale(typeof body.locale === 'string' ? body.locale : null),
  };
}

/** The session + CSRF pair the platform needs, or null when nobody is signed in. */
async function callerCookies(): Promise<string | null> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  const csrf = jar.get(CSRF_COOKIE)?.value;
  return csrf ? `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}` : `${SESSION_COOKIE}=${session}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Offline branch: the same event framing, answered from the demo merchant table. It deliberately
 * reports itself as degraded — there is no knowledge base here, and pretending otherwise would be
 * the one thing a demo must not do.
 */
async function mockAnswer(body: AskRequestBody, conversationId: string): Promise<Response> {
  const dict = getDict(body.locale);
  const seed = SEED_MERCHANTS.find(
    (merchant) => merchant.slug === body.merchant_slug || merchant.id === body.merchant_id,
  );
  const name = seed?.name ?? body.merchant_slug ?? body.merchant_id;
  const text =
    `${frame('status', { stage: 'understanding', text: dict.ask.reading })}` +
    `${frame('summary', { text: dict.ask.mockAnswer(name), citations: [] })}` +
    `${frame('done', {
      agent_run_id: `${MOCK_PREFIX}run`,
      latency_ms: 0,
      cost_usd: 0,
      degraded: true,
      provider: 'demo',
    })}`;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(text));
        await delay(0);
        controller.close();
      },
    }),
    { headers: sseHeaders(conversationId) },
  );
}

async function openConversation(cookieHeader: string, body: AskRequestBody): Promise<string | Response> {
  try {
    const opened = await nexusFetch<Record<string, unknown>>('platform', '/api/v1/conversations', {
      method: 'POST',
      cookieHeader,
      body: {
        merchant_id: body.merchant_id,
        channel: 'web',
        mode: 'ai',
        subject: body.message.slice(0, 200),
      },
    });
    const id = opened.data?.id;
    if (typeof id !== 'string' || !id) {
      return errorEnvelope(502, 'internal', 'the platform returned a conversation without an id');
    }
    return id;
  } catch (cause) {
    if (cause instanceof NexusApiError && [401, 403, 404, 422].includes(cause.status)) {
      return errorEnvelope(cause.status, cause.code, cause.message);
    }
    return errorEnvelope(502, 'internal', 'the platform is not reachable');
  }
}

/** A follow-up may only continue a thread the caller can read; otherwise it is someone else's. */
async function verifyConversation(cookieHeader: string, id: string): Promise<Response | null> {
  try {
    await nexusFetch('platform', `/api/v1/conversations/${encodeURIComponent(id)}`, { cookieHeader });
    return null;
  } catch (cause) {
    if (cause instanceof NexusApiError && cause.status === 401) {
      return errorEnvelope(401, 'unauthorized', 'sign in to continue this conversation');
    }
    return errorEnvelope(404, 'conversation_not_found', 'this conversation is not the caller\'s');
  }
}

async function liveAnswer(cookieHeader: string, body: AskRequestBody): Promise<Response> {
  let conversationId = body.conversation_id;
  if (conversationId) {
    const refused = await verifyConversation(cookieHeader, conversationId);
    if (refused) return refused;
  } else {
    const opened = await openConversation(cookieHeader, body);
    if (opened instanceof Response) return opened;
    conversationId = opened;
  }

  let upstream: Response;
  try {
    const result = await nexusFetch<Response>('ai', '/ai/v1/merchant-agent/chat', {
      method: 'POST',
      raw: true,
      timeoutMs: AI_INTERNAL_TIMEOUT_MS,
      body: {
        merchant_id: body.merchant_id,
        message: body.message,
        conversation_id: conversationId,
        context: { locale: body.locale },
      },
    });
    upstream = result.data;
  } catch (cause) {
    if (cause instanceof NexusApiError && cause.status === 422) {
      return errorEnvelope(422, 'validation_error', cause.message);
    }
    return errorEnvelope(502, 'ai_unavailable', 'the merchant agent is not reachable');
  }
  if (!upstream.body) {
    return errorEnvelope(502, 'ai_unavailable', 'the merchant agent returned no stream');
  }
  return new Response(upstream.body, { headers: sseHeaders(conversationId) });
}

export async function POST(request: Request): Promise<Response> {
  let unknown: unknown;
  try {
    unknown = await request.json();
  } catch {
    return errorEnvelope(422, 'validation_error', 'body must be valid JSON');
  }
  const body = parseBody(unknown);
  if (typeof body === 'string') return errorEnvelope(422, 'validation_error', body);

  if (IS_MOCK) {
    const conversationId = body.conversation_id?.startsWith(MOCK_PREFIX)
      ? body.conversation_id
      : `${MOCK_PREFIX}${Date.now().toString(36)}`;
    return mockAnswer(body, conversationId);
  }

  const cookieHeader = await callerCookies();
  if (!cookieHeader) {
    return errorEnvelope(401, 'unauthorized', 'sign in before asking a merchant');
  }
  return liveAnswer(cookieHeader, body);
}
