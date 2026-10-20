/**
 * `POST /api/nexus/ai/search` — the deterministic search read, and the documented §105 fallback
 * target when the SSE stream fails (API_CONTRACT §7). Same JSON contract as `POST /ai/v1/search`;
 * mock mode answers from `lib/mock` so the fallback is exercisable with no services running.
 *
 * Live mode forwards to `POST /ai/v1/search` with the exact strict body that endpoint accepts
 * (`query, geo, limit, locale` — `SearchRequest` is `extra="forbid"`, so there is no `context`
 * wrapper). `lib/data`'s `runSearch` is reused only for the mock branch, which never touches a
 * service origin; the live read is issued here so the browser-facing shape matches the service.
 */

import { DEFAULT_GEO, IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { runSearch } from '@/lib/data';
import { nexusGet } from '@/lib/api/base';
import type { SearchResponse } from '@/lib/types';
import type { GeoPoint } from '@nexus/ui/trust/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY_LENGTH = 200;

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: { code: 'validation_error', message: 'body must be a JSON object', details: null, request_id: null } }, { status: 422 });
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length > MAX_QUERY_LENGTH) {
    return json({ error: { code: 'validation_error', message: `query must be at most ${MAX_QUERY_LENGTH} characters`, details: null, request_id: null } }, { status: 422 });
  }
  const rawGeo = body.geo;
  const geo: GeoPoint =
    typeof rawGeo === 'object' &&
    rawGeo !== null &&
    Number.isFinite((rawGeo as GeoPoint).lat) &&
    Number.isFinite((rawGeo as GeoPoint).lng)
      ? { lat: (rawGeo as GeoPoint).lat, lng: (rawGeo as GeoPoint).lng }
      : { lat: DEFAULT_GEO[0], lng: DEFAULT_GEO[1] };
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const limit = typeof body.limit === 'number' && body.limit > 0 && body.limit <= 50 ? Math.floor(body.limit) : 12;

  try {
    if (IS_MOCK) {
      const result = await runSearch({ query, geo, locale, limit });
      return json({ ...result.data, mocked: result.mocked, degraded: result.degraded === true || result.data.degraded === true });
    }
    // Live: the upstream answer is verbatim (§0.1 — the BFF adds no semantics). A real empty result
    // set is an honest empty state, never backfilled with fixtures (§155).
    const data = await nexusGet<SearchResponse>('ai', '/ai/v1/search', {
      method: 'POST',
      body: { query, geo, limit, locale },
    });
    return json({ ...data, mocked: false, degraded: data.degraded === true });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    const message = cause instanceof Error ? cause.message : 'search_failed';
    return json({ error: { code, message, details: null, request_id: null } }, { status: code === 'ai_unavailable' ? 503 : 502 });
  }
}
