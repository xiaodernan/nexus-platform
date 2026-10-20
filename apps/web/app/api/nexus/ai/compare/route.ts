/**
 * `POST /api/nexus/ai/compare` — attribute-by-attribute comparison (§37) for the results page.
 *
 * Live mode forwards to `POST /ai/v1/compare`; mock mode answers from the same fixtures the search
 * used, so the comparison is over the *same* cards and the same fact ids. A cell without a
 * `fact_id` cannot render as a value, which is the whole point of the endpoint (§19).
 *
 * `geo` is forwarded when the caller supplies a well-formed point: it is the reference the AI's
 * `distance` row measures from, so omitting it silently drops that row from the grid (D401).
 */

import { IS_MOCK } from '@/lib/env';
import { nexusGet } from '@/lib/api/base';
import { mockCompare } from '@/lib/mock';
import type { CompareResult, GeoPoint } from '@nexus/ui/trust/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SUBJECTS = 4;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: { code: 'validation_error', message: 'body must be a JSON object', details: null, request_id: null } }, 422);
  }

  const ids = Array.isArray(body.subject_ids)
    ? body.subject_ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 64)
    : [];
  if (ids.length < 2) {
    return json({ error: { code: 'validation_error', message: 'subject_ids needs at least 2 ids', details: null, request_id: null } }, 422);
  }
  if (ids.length > MAX_SUBJECTS) {
    return json(
      { error: { code: 'validation_error', message: `at most ${MAX_SUBJECTS} subjects`, details: null, request_id: null } },
      422,
    );
  }

  if (IS_MOCK) return json({ ...mockCompare(ids), mocked: true });

  const rawGeo = body.geo;
  const geo: GeoPoint | null =
    typeof rawGeo === 'object' &&
    rawGeo !== null &&
    Number.isFinite((rawGeo as GeoPoint).lat) &&
    Number.isFinite((rawGeo as GeoPoint).lng)
      ? { lat: (rawGeo as GeoPoint).lat, lng: (rawGeo as GeoPoint).lng }
      : null;

  try {
    const result = await nexusGet<CompareResult>('ai', '/ai/v1/compare', {
      method: 'POST',
      body: geo ? { subject_ids: ids, geo } : { subject_ids: ids },
    });
    return json(result);
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    const message = cause instanceof Error ? cause.message : 'compare_failed';
    return json({ error: { code, message, details: null, request_id: null } }, 502);
  }
}
