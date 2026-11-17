/**
 * `POST /api/nexus/ai/world-guide` — the world guide: where to next.
 *
 * Body: `{ locale?, surface?, chapterSlug?, minutes? }`. The handler curates the two doors
 * (never the model's invention): inside a chapter it offers the next chapters in arc order,
 * elsewhere it offers the arc's front door; the AI lane phrases ONE recommendation about
 * those two real doors and names no third place.
 *
 * In mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default for tests and CI) the lane is inert:
 * `degraded:true, reason:'mock_provider'`, and the client island never mounts. In live mode the
 * upstream's answer shape is passed through verbatim, including the `measured` block.
 *
 * Failure posture (§105 fail-closed): any upstream error collapses to a 200 with
 * `degraded:true`, an empty `answer` and empty `suggestions`; the island removes itself.
 */

import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { guideList } from '@/lib/data';
import { nexusGet } from '@/lib/api/base';
import type { Guide } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CANDIDATES = 6;
const MAX_MINUTES = 1440;

type Candidate = { slug: string; title: string; blurb: string };

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

function safeParse(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(
      { error: { code: 'validation_error', message: 'body must be a JSON object', details: null, request_id: null } },
      { status: 422 },
    );
  }
  const body = safeParse(raw);
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const surfaceRaw = typeof body.surface === 'string' ? body.surface.trim().toLowerCase() : 'chapter';
  const surface = ['home', 'guides', 'chapter', 'insights', 'handbook'].includes(surfaceRaw) ? surfaceRaw : 'chapter';
  let chapterSlug = typeof body.chapterSlug === 'string' ? body.chapterSlug.trim().slice(0, 200) : '';
  try {
    chapterSlug = decodeURIComponent(chapterSlug);
  } catch {
    // a bare percent sign is not encoded text — keep the raw slug
  }
  const minutesRaw = Number(body.minutes);
  const minutes = Number.isFinite(minutesRaw)
    ? Math.max(1, Math.min(MAX_MINUTES, Math.floor(minutesRaw)))
    : 30;

  if (IS_MOCK) {
    // CI and offline planes never pay for a live call nor pretend one happened (§105).
    return json({
      degraded: true, reason: 'mock_provider', answer: '', suggestions: [], source: 'fallback', intent: 'explore',
    });
  }

  let items: Guide[] = [];
  let currentTitle = '';
  try {
    const page = await guideList(locale);
    items = page.data?.items ?? [];
    if (chapterSlug) {
      currentTitle = items.find((g) => g.slug === chapterSlug)?.title ?? '';
    }
  } catch {
    return json({
      degraded: true, reason: 'chapter_list_unavailable', answer: '', suggestions: [], source: 'fallback', intent: 'explore',
    });
  }

  const hkArc = items.filter((g) => g.slug.startsWith('hk-'));
  const pool = hkArc.length >= 3 ? hkArc : items;
  let ordered = pool;
  if (chapterSlug) {
    const idx = pool.findIndex((g) => g.slug === chapterSlug);
    if (idx >= 0) ordered = [...pool.slice(idx + 1), ...pool.slice(0, idx + 1)];
  }
  const candidates: Candidate[] = ordered.slice(0, MAX_CANDIDATES).map((g) => ({
    slug: g.slug,
    title: g.title,
    blurb: (g.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
  }));
  if (candidates.length === 0) {
    return json({
      degraded: true, reason: 'no_candidates', answer: '', suggestions: [], source: 'fallback', intent: 'explore',
    });
  }

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/world/guide', {
      method: 'POST',
      body: {
        locale,
        surface,
        current_title: currentTitle,
        minutes,
        candidates,
      },
    });
    return json({ ...data });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    return json({
      degraded: true, reason: code, answer: '', suggestions: [], source: 'fallback', intent: 'explore',
    });
  }
}
