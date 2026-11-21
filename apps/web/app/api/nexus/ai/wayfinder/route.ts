/**
 * `POST /api/nexus/ai/wayfinder` — the reader-state wayfinder CTA, proxied to the AI service.
 * No automatic call: the island asks only when the reader clicks. Mock mode is inert (§105).
 * The mood is a fixed vocabulary from the graph — never free-form text (injection fence).
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

const EMPTY = {
  chapter: 0, title: '', why: '', notice: '', confidence: 'low', degraded: true,
};

const MOODS = new Set(['continue', 'revisit', 'late_night', 'warm_food', 'keep_the_promise']);

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const position = typeof body.position === 'number' && Number.isFinite(body.position)
    ? Math.min(1000, Math.max(0, Math.trunc(body.position)))
    : 0;
  const mood = typeof body.mood === 'string' && MOODS.has(body.mood) ? body.mood : 'continue';
  if (IS_MOCK) return json({ ...EMPTY, reason: 'mock_provider' });
  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/world/wayfinder', {
      method: 'POST',
      body: { locale, position, mood },
    });
    return json({ ...data });
  } catch {
    return json({ ...EMPTY, reason: 'ai_unavailable' });
  }
}
