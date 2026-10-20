/**
 * `POST /api/nexus/ai/stream` — the BFF proxy for `POST /ai/v1/search/stream` (§7, §116).
 *
 * Why a proxy: the browser must never hold a service origin, a session header or a tenant header
 * (API_CONTRACT §0); the events themselves are the documented canonical stream, untouched.
 *
 * In mock mode the very same SSE framing is produced locally from `mockSearchStream`, so the
 * browser code path — parse, stage, degrade — is identical whether or not :8000 is running. That
 * is deliberate: §105 behaviour must be reviewable offline, and "works only against live" is not
 * verification.
 */

import { nexusFetch, NexusApiError } from '@/lib/api/base';
import { AI_INTERNAL_TIMEOUT_MS, IS_MOCK } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { mockSearchStream, type MockStreamEvent, type StreamInput } from '@/lib/mock';
import type { GeoPoint } from '@nexus/ui/trust/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY_LENGTH = 200;

interface StreamRequestBody {
  query: string;
  conversation_id: string | null;
  previous_intent: Record<string, unknown> | null;
  geo: GeoPoint | null;
  locale: string;
  /** §105 demo switch: fail the stream on purpose. Mock mode only — see `parseBody`. */
  force_error: boolean;
}

function eventStreamHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function envelope(code: string, message: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: { code, message, details: details ?? null, request_id: null } }),
    { status: code === 'validation_error' ? 422 : 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/** A malformed or oversized query is a 422 before any model call is paid for. */
function parseBody(value: unknown): StreamRequestBody | string {
  if (typeof value !== 'object' || value === null) return 'body must be a JSON object';
  const body = value as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return 'query is required';
  if (query.length > MAX_QUERY_LENGTH) return `query must be at most ${MAX_QUERY_LENGTH} characters`;
  const conversationId = typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : null;
  const previousIntent =
    typeof body.previous_intent === 'object' && body.previous_intent !== null ? (body.previous_intent as Record<string, unknown>) : null;
  const rawGeo = body.geo;
  const geo =
    typeof rawGeo === 'object' && rawGeo !== null && Number.isFinite((rawGeo as GeoPoint).lat) && Number.isFinite((rawGeo as GeoPoint).lng)
      ? { lat: (rawGeo as GeoPoint).lat, lng: (rawGeo as GeoPoint).lng }
      : null;
  const locale = typeof body.locale === 'string' && body.locale ? body.locale : 'zh-HK';
  // Live mode has no way to honour this and must not appear to, so the flag is dropped rather than
  // forwarded: a reviewer who sets it against a real :8000 gets a real stream, not a fake failure.
  const forceError = IS_MOCK && body.force_error === true;
  return { query, conversation_id: conversationId, previous_intent: previousIntent, geo, locale, force_error: forceError };
}

function fromMock(input: StreamInput, locale: string): ReadableStream<Uint8Array> {
  const dict = getDict(locale);
  const encoder = new TextEncoder();
  const iterator = mockSearchStream(input, { ...dict.search.stages, found: dict.search.found });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frame(next.value.event, next.value.data)));
    },
    async cancel() {
      // `TReturn` is `void`, which still requires the argument position to be filled in TS.
      await iterator.return?.(undefined);
    },
  });
}

/** Live: forward the upstream byte stream verbatim, so no event can be "improved" in transit. */
function fromUpstream(request: Request, body: StreamRequestBody): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const upstream = await nexusFetch<Response>('ai', '/ai/v1/search/stream', {
          method: 'POST',
          body: {
            query: body.query,
            conversation_id: body.conversation_id,
            previous_intent: body.previous_intent,
            context: { geo: body.geo, locale: body.locale, now: new Date().toISOString() },
          },
          cookieHeader: request.headers.get('cookie'),
          raw: true,
          timeoutMs: AI_INTERNAL_TIMEOUT_MS,
        });
        const stream = upstream.data.body;
        if (!stream) throw new NexusApiError('empty_stream_from_ai', { status: 502, code: 'ai_unavailable' });
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (cause) {
        // §7: `error` is a stream event, and the client's contract for it is "fall back to
        // POST /ai/v1/search" — so the failure has to travel inside the stream, not as a 500.
        const code = cause instanceof NexusApiError ? cause.code : 'ai_unavailable';
        const message = cause instanceof Error ? cause.message : 'stream_failed';
        controller.enqueue(encoder.encode(frame('error', { code, message, request_id: null })));
        controller.close();
      }
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let unknown: unknown;
  try {
    unknown = await request.json();
  } catch {
    return envelope('validation_error', 'body must be valid JSON');
  }
  const body = parseBody(unknown);
  if (typeof body === 'string') return envelope('validation_error', body);

  const input: StreamInput = {
    query: body.query,
    conversationId: body.conversation_id,
    previousIntent: body.previous_intent as StreamInput['previousIntent'],
    geo: body.geo,
    locale: body.locale,
    forceError: body.force_error,
  };

  try {
    const stream = IS_MOCK ? fromMock(input, body.locale) : fromUpstream(request, body);
    return new Response(stream, { headers: eventStreamHeaders() });
  } catch (cause) {
    const event: MockStreamEvent = { event: 'error', data: { code: 'internal', message: String(cause) } };
    return new Response(frame(event.event, event.data), { headers: eventStreamHeaders(), status: 200 });
  }
}
