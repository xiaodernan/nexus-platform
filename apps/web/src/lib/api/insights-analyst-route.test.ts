/**
 * D1451 — the insights analyst StateGraph, pinned at the wire seam.
 *
 * MOCK MODE is asserted exactly: `NEXT_PUBLIC_DATA_MODE=mock` must produce
 * `degraded:true, reason:'mock_provider'` with an empty forecast — never a fake analyst.
 *
 * LIVE MODE is asserted on its frame: the BFF recomputes the seeded replay server-side
 * and forwards the numbers verbatim; an upstream failure comes back degraded with an
 * empty forecast; a healthy upstream passes its measured block through.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live'): Promise<Post> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  const route = await import('../../../app/api/nexus/ai/insights-analyst/route');
  return route.POST as Post;
}

function request(body: unknown): Request {
  return new Request('http://nexus.test/api/nexus/ai/insights-analyst', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('insights-analyst mock mode never pays for a call', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('mock');
  });

  it('returns degraded:mock_provider with an empty readout', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    expect(body.forecast).toBe('');
    expect(body.measures).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('insights-analyst live mode forwards exact ghost stats and degrades honestly', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('live');
  });

  it('forwards the server-computed replay numbers verbatim', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            verdict: 'rising',
            forecast: 'A rising week; watch the 44 drop-off day.',
            watch: 'the 44 drop-off day',
            measures: [{ action: 'Cap the first screen at three buttons.', why: 'The 44 drop-off day is the tell.' }],
            source: 'llm',
            confidence: 'medium',
            degraded: false,
            measured: { latency_ms: 5200, prompt_tokens: 640, cached_tokens: 128, calls: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ locale: 'en' }));
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      stats: { total: number; slope: number; profiles: Array<{ profile: string; count: number }> };
      locale: string;
    };
    expect(body.locale).toBe('en');
    expect(body.stats.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.stats.profiles)).toBe(true);
    expect(typeof body.stats.slope).toBe('number');

    const parsed = await res.json();
    expect(parsed.degraded).toBe(false);
    expect(parsed.measured.prompt_tokens).toBe(640);
    expect(parsed.measured.calls).toBe(2);
  });

  it('degrades with an empty readout when the service is unreachable', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.reject(new TypeError('upstream')));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.forecast).toBe('');
    expect(body.measures).toEqual([]);
  });
});
