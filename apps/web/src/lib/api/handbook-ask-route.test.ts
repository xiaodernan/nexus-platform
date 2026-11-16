/**
 * D1279 — the handbook's live-phrasing lane, pinned.
 *
 * MOCK MODE is asserted exactly: `NEXT_PUBLIC_DATA_MODE=mock` (the default for tests and CI)
 * must return `degraded:true, reason:'mock_provider'` with an EMPTY answer — never a call,
 * never a cached pretend, never a fabricated phrasing. The offline plane stays honest.
 *
 * LIVE MODE is asserted on its seam contract: with the upstream wired to a spy, `sections`
 * must reach the AI service with the manual's own ids and bodies (top-6, truncated at 2400),
 * and any upstream failure must come back as `degraded:true` with an empty answer — the page
 * keeps its deterministic fetch and this lane never appears.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live'): Promise<Post> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  const route = await import('../../../app/api/nexus/ai/handbook-ask/route');
  return route.POST as Post;
}

function request(body: unknown): Request {
  return new Request('http://nexus.test/api/nexus/ai/handbook-ask', {
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

describe('mock mode never performs a model call', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('mock');
  });

  it('answers with degraded:mock_provider and an empty answer', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: 'how do I search', locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    expect(body.answer).toBe('');
    expect(body.citations).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a too-short question without touching anything', async () => {
    const res = await post(request({ question: '  ', locale: 'en' }));
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('question_too_short');
  });
});

describe('live mode sends manual sections to the service and degrades honestly', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('live');
  });

  it('forwards picked sections with english locale tags and passes measured values through', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            answer: 'Type one sentence; the SearchBox reads it.',
            citations: [{ id: 'search', title: 'SEARCH' }],
            confidence: 'high',
            degraded: false,
            measured: { latency_ms: 6400, prompt_tokens: 400, cached_tokens: 350, cache_reported: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: 'how do I search', locale: 'en' }));
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1] as RequestInit | undefined;
    expect(init).toBeDefined();
    const body = JSON.parse(String((init as RequestInit).body)) as { question: string; locale: string; sections: Array<{ id: string; body: string }> };
    expect(body.question).toBe('how do I search');
    expect(body.locale).toBe('en');
    expect(body.sections.length).toBeGreaterThan(0);
    for (const section of body.sections) {
      expect(section.id.length).toBeGreaterThan(0);
      expect(section.body.length).toBeLessThanOrEqual(2400);
    }

    const parsed = await res.json();
    expect(parsed.degraded).toBe(false);
    expect(parsed.measured.prompt_tokens).toBe(400);
    expect(parsed.measured.cached_tokens).toBe(350);
  });

  it('returns degraded with an empty answer when the service is unreachable', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown) => Promise.reject(new TypeError('upstream_unreachable')));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: 'how do I search', locale: 'en' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.answer).toBe('');
  });
});
