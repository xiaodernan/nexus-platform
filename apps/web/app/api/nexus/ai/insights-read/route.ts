/**
 * `POST /api/nexus/ai/insights-read` — the operator's ghost-replay, read aloud by the model.
 *
 * Recomputes the deterministic replay server-side (HK date, 22 ghost readers, profiles, hour
 * ramp, recommendation), passes those exact numbers to the AI service, and hands back one
 * paragraph + one focus line with a provenance badge. The deterministic ghost view still
 * renders — this route never replaces it, it sits above it.
 *
 * In mock mode (CI + offline planes) the route returns `degraded: true, reason: 'mock_provider'`
 * and an empty paragraph; the page keeps its full deterministic view. In live mode the AI
 * service reads the payload only through this route; the model has no store, no session, no
 * identity — it sees exactly what this route forwards, nothing else.
 *
 * Failure posture (§105 fail-closed): any upstream error, timeout, or non-JSON answer returns
 * `degraded: true`; the /insights page keeps its deterministic render and never blocks on this.
 */

import { IS_MOCK } from '@/lib/env';
import { normalizeLocale } from '@/lib/i18n';
import { nexusGet } from '@/lib/api/base';
import { simulateJourneys, simulateWeek } from '@/lib/user-journeys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

function hkDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // locale-only payload is fine to skip; no data leaves the caller either way
    body = {};
  }

  const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : null);
  const date = hkDate();
  const snap = simulateJourneys(date, locale);
  const week = simulateWeek(date, locale);
  const pointCounts = snap.buckets.map((b) => ({ profile: b.profile, count: b.count }));
  if (IS_MOCK) {
    // CI and offline planes never pay for a call nor pretend one happened (§105).
    return json({
      degraded: true,
      reason: 'mock_provider',
      paragraph: '',
      focus: '',
      confidence: 'low',
    });
  }

  const stats = {
    date,
    total: snap.total,
    hourRamp: snap.hourRamp,
    headline: snap.headline,
    recommendation: snap.recommendation,
    profiles: pointCounts,
    week: {
      weeklyTotal: week.weeklyTotal,
      slope: week.slope,
      adviceKind: week.adviceKind,
      points: week.points.map((p) => ({
        date: p.date, total: p.total, dropRate: p.dropRate, topProfile: p.topProfile,
      })),
    },
    slope: week.slope,
  };

  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/insights/narrative', {
      method: 'POST',
      body: { stats, locale },
    });
    return json({ ...data });
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? 'ai_unavailable';
    return json({
      degraded: true,
      reason: code,
      paragraph: '',
      focus: '',
      confidence: 'low',
    });
  }
}
