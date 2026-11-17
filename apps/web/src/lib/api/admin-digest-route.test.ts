/**
 * D1285 — the operator digest lane, pinned.
 *
 * The gate is the contract here: a signed-out caller gets `degraded:true, reason:'admin_denied'`
 * and ZERO upstream calls; a signed-in caller in mock mode reaches the gate and then stops
 * (`mock_provider`), still ZERO calls to the AI service; in live mode the sanitized event
 * counters are forwarded verbatim and upstream `measured` passes through; any failure leaves
 * the console with the counters alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live', cookie?: string): Promise<Post> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  vi.doMock('next/headers', () => ({
    cookies: async () => ({
      get: (name: string) => (cookie ? { name, value: cookie } : undefined),
      getAll: () => (cookie ? [{ name: 'nexus_session', value: cookie }] : []),
    }),
  }));
  const route = await import('../../../app/api/nexus/admin/digest/route');
  return route.POST as Post;
}

function request(body: unknown): Request {
  return new Request('http://nexus.test/api/nexus/admin/digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('mock mode grants the demo identity — the lane is then inert, zero AI calls', () => {
  it('returns mock_provider with an empty payload and performs zero upstream calls', async () => {
    const post = await load('mock');
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ events: { xlen: 3 }, locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    expect(body.reading).toBe('');
    expect(body.actions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('live mode refuses signed-out callers before anything else', () => {
  it('returns admin_denied with an empty payload and performs zero upstream calls', async () => {
    const post = await load('live');
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ events: { xlen: 3 }, locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('admin_denied');
    expect(body.reading).toBe('');
    expect(body.actions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('mock mode past the gate is inert and spends zero AI calls', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('mock', 'session-token');
  });

  it('the §68 /me read is allowed; the AI digest is never called', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/api/v1/me') || u.includes('/me')) {
        return new Response(JSON.stringify({ role: 'platform_admin' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ events: { xlen: 3, topTemplates: ['guide_read'] }, locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    const aiCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/ai/v1/admin/digest'));
    expect(aiCalls.length).toBe(0);
  });
});

describe('live mode forwards sanitized counters and passes measured through', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('live', 'session-token');
  });

  it('sanitizes templates and counters; envelope passes through verbatim', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/me')) {
        return new Response(JSON.stringify({ role: 'platform_admin' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({
          reading: 'Two pending deliveries with one consumer; drain the group.',
          actions: [{ action: 'Drain the group', why: 'pending=2 vs 1 consumer' }],
          confidence: 'high',
          degraded: false,
          measured: { latency_ms: 4100, prompt_tokens: 700, cached_tokens: 0, cache_reported: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({
      events: { xlen: 913.9, pending: 2, consumers: 1, disabled: false, degraded: false, recentCount: 5, topTemplates: ['a'.repeat(500), 42, 'guide_read'] },
      locale: 'en',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(false);
    expect(body.measured.prompt_tokens).toBe(700);

    const aiCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/ai/v1/admin/digest'));
    expect(aiCall).toBeDefined();
    const init = aiCall![1] as unknown as RequestInit;
    const sent = JSON.parse(String(init.body)) as { events: Record<string, unknown> };
    expect(sent.events.xlen).toBe(913);
    expect(Array.isArray(sent.events.top_templates)).toBe(true);
    const templates = sent.events.top_templates as string[];
    expect(templates.length).toBeLessThanOrEqual(4);
    for (const t of templates) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeLessThanOrEqual(60);
    }
  });

  it('an unreachable AI service degrades to an empty digest (the console keeps the counters)', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/me')) {
        return new Response(JSON.stringify({ role: 'platform_ops' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return Promise.reject(new TypeError('upstream_unreachable'));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ events: { xlen: 10 }, locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reading).toBe('');
  });
});
