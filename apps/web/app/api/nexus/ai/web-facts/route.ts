/**
 * `POST /api/nexus/ai/web-facts` — real public reference data via the SSRF-guarded tool.
 * No LLM call: the AI service dispatches its allow-listed Wikipedia search. Mock is inert.
 */
import { IS_MOCK } from '@/lib/env';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

const EMPTY = { query: '', results: [], source: 'third_party', confidence: 'low', degraded: true };

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : '';
  const language = body.language === 'en' ? 'en' : 'zh';
  if (!query) return json({ ...EMPTY, reason: 'invalid_query' }, { status: 422 });
  if (IS_MOCK) return json({ ...EMPTY, reason: 'mock_provider' });
  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/world/web-facts', {
      method: 'POST', body: { query, language },
    });
    return json({ ...data });
  } catch {
    return json({ ...EMPTY, reason: 'web_search_unavailable' });
  }
}
