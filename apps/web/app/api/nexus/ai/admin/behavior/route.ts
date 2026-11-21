/**
 * `GET /api/nexus/ai/admin/behavior` — the password-123 analytics read (§九).
 * Offline (the default plane): serve a deterministic, labelled DEMO payload derived from
 * the same ghost readers /insights shows — never empty zeros, never a fabricated claim
 * about real rows. Live: proxy to the AI service's real §58 events read.
 */
import { IS_MOCK } from '@/lib/env';
import { demoBehavior } from '@/lib/behavior-events';
import { nexusGet } from '@/lib/api/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') ?? '';
  if (password !== '123') {
    return json({ error: { code: 'admin_password', message: 'password 123 required' } }, { status: 403 });
  }
  const hoursRaw = Number(url.searchParams.get('hours'));
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(24 * 30, Math.trunc(hoursRaw)) : 720;

  if (IS_MOCK) {
    const day = new Date().toISOString().slice(0, 10);
    return json(demoBehavior(day, 'zh-HK', hours));
  }
  try {
    const data = await nexusGet<Record<string, unknown>>('ai', '/ai/v1/admin/behavior', {
      searchParams: { password, hours: String(hours) },
    });
    return json({ ...data });
  } catch {
    // The live read is unreachable: fall back to the deterministic, clearly-labelled demo
    // crowd instead of a wall of fake zeros or a dead panel. Never claim it is real.
    const day = new Date().toISOString().slice(0, 10);
    return json({ ...demoBehavior(day, 'zh-HK', hours), fallback: 'live_unreachable' });
  }
}
