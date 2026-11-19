/**
 * `POST /api/nexus/ai/chapter-ask` — one chapter answers one reader, grounded.
 *
 * Body: `{ question, chapterSlug, locale? }`. The handler loads the chapter through the SAME
 * read path the reader already uses (`guideBySlug`, the mock plane in CI/offline, the platform
 * read in live mode) and hands the model the top excerpts that overlap the question — nothing
 * else in the product is a source of truth here.
 *
 * In mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default for tests and CI) the lane is inert:
 * `degraded:true, reason:'mock_provider'`, and the client island never mounts. In live mode the
 * upstream's answer shape is passed through verbatim, including the `measured` block — the
 * admin console and the ledger see real token use, cache hit and latency.
 *
 * Failure posture (§105 fail-closed): upstream error, wrong citation, URL leak, a confident
 * answer with no citation, an empty chapter — the client gets a 200 with `degraded:true` and an
 * empty `answer`; the island removes itself; the reader keeps exactly the chapter that was
 * already rendered, plus nothing.
 */

import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { guideBySlug } from '@/lib/data';
import { nexusGet } from '@/lib/api/base';
import type { Guide } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUESTION = 300;
const PARA_LIMIT = 1600;
const NEIGHBOR_BLOCK_LIMIT = 700;
const PICKED = 12;

type Excerpt = { id: string; kicker: string; title: string; body: string; index: number };

const WORD_RE = /[a-z0-9_]+/g;
const CJK_RE = /[\u4e00-\u9fff]+/g;

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length >= 2) tokens.add(w);
  }
  for (const m of lower.matchAll(CJK_RE)) {
    const run = m[0];
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
    if (run.length >= 3) tokens.add(run);
  }
  return tokens;
}

function atlasHeaderLine(guide: Guide, locale: string): string {
  const loc = normalizeLocale(locale);
  const line = (guide.title || '').split('：', 1)[0].split('—', 1)[0].trim();
  const total = guide.title_en || '';
  if (loc === 'en') {
    return `[CHAPTER CONTEXT — The Hong Kong arc made real. This chapter is one of 130+ narrative constructions; every merchant is synthetic. The present chapter: ${total}]`;
  }
  if (loc === 'zh-CN') {
    return `[章节上下文 — 香港系列合成叙事。本篇是 130+ 章之一；所有商户均为虚构示例。本篇：${line}]`;
  }
  return `[章節上下文 — 香港系列合成敘事。本篇是 130+ 章之一；所有商戶均為虛構示例。本篇：${line}]`;
}

function excerptParagraphs(guide: Guide): Excerpt[] {
  const out: Excerpt[] = [];
  (guide.body_blocks ?? []).forEach((block, index) => {
    if (block.type !== 'paragraph') return;
    const body = typeof block.text === 'string' ? block.text : '';
    if (!body.trim()) return;
    out.push({
      id: `p${index + 1}`,
      kicker: guide.category ?? '',
      title: `${guide.title} · §${index + 1}`,
      body: body.slice(0, PARA_LIMIT),
      index,
    });
  });
  return out;
}

function pickExcerpts(question: string, paragraphs: Excerpt[]): Excerpt[] {
  const tokens = tokenize(question);
  if (tokens.size === 0) return paragraphs.slice(0, PICKED);
  const scored = paragraphs.map((p) => {
    let score = 0;
    for (const token of tokenize(p.body)) if (tokens.has(token)) score += 1;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || a.p.index - b.p.index);
  const hits = scored.filter((s) => s.score > 0);
  if (hits.length > 0) return hits.slice(0, PICKED).map((s) => s.p).sort((a, b) => a.index - b.index);
  // No overlap at all: give the model the bookends and the midpoint — never invent a narrative.
  const mid = Math.floor(paragraphs.length / 2);
  const spread = [paragraphs[0], paragraphs[mid], paragraphs[paragraphs.length - 1]].filter(
    (p): p is Excerpt => Boolean(p),
  );
  const seen = new Set<number>();
  return spread.filter((p) => (seen.has(p.index) ? false : (seen.add(p.index), true))).slice(0, PICKED).sort((a, b) => a.index - b.index);
}

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

  const question = typeof body.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION) : '';
  if (question.length < 3) {
    return json({ degraded: true, reason: 'question_too_short', answer: '', citations: [], confidence: 'low' });
  }
  const chapterSlug = typeof body.chapterSlug === 'string' ? body.chapterSlug.trim().slice(0, 200) : '';
  if (chapterSlug.length < 1) {
    return json({ degraded: true, reason: 'chapter_required', answer: '', citations: [], confidence: 'low' });
  }
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);

  if (IS_MOCK) {
    // CI and offline planes never pay for a call nor pretend one happened (§105).
    return json({ degraded: true, reason: 'mock_provider', answer: '', citations: [], confidence: 'low' });
  }

  let guide: Guide | null;
  try {
    guide = (await guideBySlug(decodeURIComponent(chapterSlug), locale)).data;
  } catch {
    return json({ degraded: true, reason: 'chapter_unavailable', answer: '', citations: [], confidence: 'low' });
  }
  if (!guide) {
    return json({ degraded: true, reason: 'chapter_not_found', answer: '', citations: [], confidence: 'low' });
  }

  const excerpts = excerptParagraphs(guide);
  if (excerpts.length === 0) {
    return json({ degraded: true, reason: 'chapter_empty', answer: '', citations: [], confidence: 'low' });
  }
  const picked = pickExcerpts(question, excerpts);
  // Compose a big-context payload: atlas line + up to PICKED excerpts + the chapter's full synopsis.
  const fullEnumerate = excerpts.length <= PICKED;
  // When only 6 paragraphs total, send fullExcerpts instead — every paragraph, not a subset.
  const fullBlock = fullEnumerate
    ? excerpts.map((p) => `[${p.id}] ${p.title}\n${p.body}`).join('\n\n')
    : picked.map((p) => `[${p.id}] ${p.title}\n${p.body}`).join('\n\n');
  const atlasLine = atlasHeaderLine(guide, locale);
  const augment = atlasLine;

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/chapter/ask', {
      method: 'POST',
      body: {
        question,
        locale,
        chapter_id: guide.slug,
        chapter_title: guide.title,
        sections: picked.map((p) => ({ id: p.id, kicker: p.kicker, title: p.title, body: p.body })),
        atlas_context: augment,
      },
    });
    return json({ ...data, picked: picked.map((p) => p.id) });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    const message = cause instanceof Error ? cause.message : 'chapter_ask_failed';
    return json({ degraded: true, reason: code, message, answer: '', citations: [], confidence: 'low' }, { status: 200 });
  }
}
