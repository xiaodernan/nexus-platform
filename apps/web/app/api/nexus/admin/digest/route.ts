/**
 * `POST /api/nexus/admin/digest` — the operator's mirror, phrased by the model. §68-gated.
 *
 * Body: `{ events: { xlen, pending, consumers, disabled, degraded, recentCount, topTemplates? }, locale? }`.
 * The gate is the SAME §68 role check every admin page performs before reading anything — a
 * signed-out or non-admin caller gets `degraded:true, reason:'admin_denied'` and ZERO upstream
 * calls; the AI lane never sees this route without the operator's session.
 *
 * In mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default for tests and CI) the lane is inert:
 * `degraded:true, reason:'mock_provider'` once the caller is past the gate.
 *
 * Failure posture (§105 fail-closed): any upstream error, URL leak, a number the model wrote
 * that the operator's own counters do not contain, empty output — the client gets a 200 with
 * `degraded:true` and empty content; the console keeps rendering the counters alone.
 */

import { cookies } from 'next/headers';

import { IS_MOCK, SESSION_COOKIE } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { adminGate } from '@/lib/console-admin';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TEMPLATES = 4;
const MAX_TEMPLATE = 60;

const intOrNull = (v: unknown, cap = 10_000_000): number | null =>
  Number.isFinite(v) ? Math.min(Math.max(0, Math.floor(Number(v))), cap) : null;

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

  // §68 identity gate — the same fail-closed check the admin pages read at the door.
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);
  const cookieHeader = jar.getAll().map((entry) => `${entry.name}=${entry.value}`).join('; ') || null;
  const access = await adminGate({ signedIn, cookieHeader });
  if (!access.granted) {
    // A signed-out or non-admin caller performs zero upstream calls.
    return json({ degraded: true, reason: 'admin_denied', reading: '', actions: [], confidence: 'low' });
  }

  if (IS_MOCK) {
    // CI and offline planes never pay for a call nor pretend one happened (§105).
    return json({ degraded: true, reason: 'mock_provider', reading: '', actions: [], confidence: 'low' });
  }

  const rawEvents = (typeof body.events === 'object' && body.events !== null ? body.events : {}) as Record<string, unknown>;
  const rawTemplates = rawEvents.topTemplates ?? rawEvents.top_templates;
  const topTemplates = Array.isArray(rawTemplates)
    ? rawTemplates
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.slice(0, MAX_TEMPLATE))
        .slice(0, MAX_TEMPLATES)
    : [];

  const events = {
    xlen: intOrNull(rawEvents.xlen),
    pending: intOrNull(rawEvents.pending),
    consumers: intOrNull(rawEvents.consumers, 10_000),
    disabled: rawEvents.disabled === true,
    degraded: rawEvents.degraded === true,
    recent_count: intOrNull(rawEvents.recentCount ?? rawEvents.recent_count, 1000) ?? 0,
    top_templates: topTemplates,
  };
  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/admin/digest', {
      method: 'POST',
      body: { events, locale },
    });
    return json(data);
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    const message = cause instanceof Error ? cause.message : 'admin_digest_failed';
    return json({ degraded: true, reason: code, message, reading: '', actions: [], confidence: 'low' }, { status: 200 });
  }
}
