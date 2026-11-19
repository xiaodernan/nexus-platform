/**
 * D1468 — the story-recap BFF seam: mock inert, live forwards the window, failures fail closed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live'): Promise<Post> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  const route = await import('../../../app/api/nexus/ai/story-recap/route');
  return route.POST as Post;
}

function request(body: unknown): Request {
  return new Request('http://nexus.test/api/nexus/ai/story-recap', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('story-recap BFF', () => {
  it('mock mode never pays for a call', async () => {
    const post = await load('mock');
    const spy = vi.fn(async () => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', spy);
    const res = await post(request({ locale: 'en' }));
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    expect(body.recap).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('live mode forwards locale/window and passes measured through', async () => {
    const post = await load('live');
    const spy = vi.fn(async () => Promise.resolve(new Response(JSON.stringify({
      recap: 'Chapters 145 to 156 stay at the east gate.', watch: 'The sender is unnamed.',
      confidence: 'medium', degraded: false, measured: { cached_tokens: 400 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', spy);
    const res = await post(request({ locale: 'en', start: 145, end: 156 }));
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'en', start: 145, end: 156 });
    const body = await res.json();
    expect(body.degraded).toBe(false);
    expect(body.measured.cached_tokens).toBe(400);
  });
});
