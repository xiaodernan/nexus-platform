/**
 * `POST /api/nexus/ai/npc-ah-wan` — talk to Ah Wan, the night-shift tower cleaner.
 *
 * Body: `{ locale?, message, history? }`. A single short turn of an in-world conversation: the
 * StateGraph classifies (deflect/voice) and phrases it. The history rides the request (client-side
 * state), so the byte prefix stays growing turn after turn and the provider's cache can serve it.
 *
 * In mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default for tests and CI) the lane is inert:
 * `degraded:true, reason:'mock_provider'`, and the island never mounts. In live mode the
 * upstream's answer shape is passed through verbatim, including the `measured` block.
 *
 * Failure posture (§105 fail-closed): any upstream error collapses to a 200 with
 * `degraded:true` and an empty `answer`; the island removes itself; the page stands untouched.
 */

import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HISTORY = 12;
const MAX_CONTENT = 400;
const MAX_MESSAGE = 220;

type HistoryItem = { role: 'user' | 'assistant'; content: string };

function parseHistory(raw: unknown): HistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryItem[] = [];
  for (const item of raw.slice(-MAX_HISTORY)) {
    if (typeof item !== 'object' || item === null) continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof content !== 'string') continue;
    const trimmed = content.trim().slice(0, MAX_CONTENT);
    if (!trimmed) continue;
    out.push({ role: role === 'user' ? 'user' : 'assistant', content: trimmed });
  }
  return out;
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json(
      { error: { code: 'validation_error', message: 'body must be a JSON object', details: null, request_id: null } },
      { status: 422 },
    );
  }

  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  if (message.length < 1) {
    return json({ degraded: true, reason: 'message_required', answer: '', degraded_source: 'fallback' });
  }
  const history = parseHistory(body.history);

  if (IS_MOCK) {
    // CI and offline planes never pay for a live call nor pretend one happened (§105).
    return json({ degraded: true, reason: 'mock_provider', answer: '', source: 'fallback' });
  }

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/npc/ah-wan', {
      method: 'POST',
      body: { locale, message, history },
    });
    return json({ ...data });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    return json({ degraded: true, reason: code, answer: '', source: 'fallback' });
  }
}
