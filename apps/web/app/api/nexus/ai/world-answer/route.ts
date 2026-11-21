/**
 * `POST /api/nexus/ai/world-answer` — ask a question across the WHOLE chapter corpus.
 * One explicit click; the AI lane retrieves real chapter bodies, phrases one fenced answer.
 * Mock mode is inert (§105). Query length is bounded at the proxy.
 */
import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

const EMPTY = { answer: '', confidence: 'low', chapters: [], degraded: true };

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  // D1514: the proxy repeats the depth whitelist; the service repeats it again. Neither
  // trusts the other, and a client cannot send a raw char budget through either hop.
  const depth = body.depth === 'deep' ? 'deep' : 'quick';
  if (!query) return json({ ...EMPTY, reason: 'invalid_query' }, { status: 422 });
  if (IS_MOCK) return json({ ...EMPTY, reason: 'mock_provider' });
  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/world/answer', {
      method: 'POST',
      body: { query, locale, depth },
    });
    return json({ ...data });
  } catch {
    return json({ ...EMPTY, reason: 'ai_unavailable' });
  }
}
