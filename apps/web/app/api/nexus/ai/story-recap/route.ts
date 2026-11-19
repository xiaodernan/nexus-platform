/**
 * `POST /api/nexus/ai/story-recap` — the reader's orientation CTA, proxied to the AI service.
 * No automatic call: the island asks only when the reader clicks. Mock mode is inert (§105).
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

const EMPTY = { recap: '', watch: '', confidence: 'low', degraded: true };

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const start = typeof body.start === 'number' && Number.isInteger(body.start) ? body.start : 0;
  const end = typeof body.end === 'number' && Number.isInteger(body.end) ? body.end : 0;
  if (IS_MOCK) return json({ ...EMPTY, reason: 'mock_provider' });
  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/story/recap', {
      method: 'POST',
      body: { locale, start, end },
    });
    return json({ ...data });
  } catch {
    return json({ ...EMPTY, reason: 'ai_unavailable' });
  }
}
