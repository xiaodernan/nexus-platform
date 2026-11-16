/**
 * `POST /api/nexus/ai/handbook-ask` — the live model phrases the manual's answer, grounded.
 *
 * Body: `{ question, locale? }`. The handler runs the SAME deterministic retrieval the page
 * already showed (`retrieve`, top-6, the sections most likely to answer) and hands those
 * sections to the AI service, which may rephrase them — no other source of truth is allowed.
 *
 * In mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default for tests and CI) the lane is
 * inert: `degraded:true, reason:'mock_provider'` and the page keeps its server-rendered
 * retrieval answer, byte-identical to before this endpoint existed. In live mode the
 * upstream's answer shape is passed through verbatim, including its `measured` block, so
 * the page — and the admin console downstream — can see the model's real token use.

 * Failure posture (§105 fail-closed): any upstream error, timeout, non-JSON answer, URL
 * leak, zero citation on a non-low-confidence answer, or missing corpus — the client gets a
 * 200 with `degraded:true` and an empty `answer`, and the page falls back to retrieval.
 */

import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { retrieve } from '@/lib/manual-rag';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUESTION = 400;
const SECTION_CHAR_LIMIT = 2400;

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
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);

  if (IS_MOCK) {
    // CI and offline planes never pay for a call nor pretend one happened (§105).
    return json({ degraded: true, reason: 'mock_provider', answer: '', citations: [], confidence: 'low' });
  }

  // The model sees the top-6 sections the retrieval lane already believes relevant — never the whole dict.
  const picked = retrieve(question, locale, 6).map((section) => ({
    id: section.id,
    kicker: section.kicker,
    title: section.title,
    body: section.corpus.slice(0, SECTION_CHAR_LIMIT),
  }));

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/handbook/ask', {
      method: 'POST',
      body: { question, locale, sections: picked },
    });
    return json({ ...data, sections: picked.map((s) => s.id) });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    const message = cause instanceof Error ? cause.message : 'handbook_ask_failed';
    return json({ degraded: true, reason: code, message, answer: '', citations: [], confidence: 'low' }, { status: 200 });
  }
}
