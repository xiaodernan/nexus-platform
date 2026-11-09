/**
 * D846 — a consumer question crosses two seams before it becomes an answer: the BFF's own
 * validation, and the mode switch. This file pins both.
 *
 * The mock branch is exercised without any session on purpose: it writes nothing, so it must stay
 * reviewable offline (§105/§641), and the `done` frame has to say `provider: demo` so the UI can
 * label it as a demo instead of presenting a scripted paragraph as a grounded answer.
 *
 * The live branch is exercised with a jar that holds no session: the answer there writes to the
 * platform and costs a model call, so a signed-out caller must be refused before either service is
 * touched — asserted by a fetch spy that must stay at zero calls.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readSse } from '@/lib/sse';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live'): Promise<Post> {
  // `IS_MOCK` is a module-load constant, so the env is stubbed BEFORE the import and the registry
  // is reset between modes; otherwise the second describe would inspect the first module.
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  const route = await import('../../../app/api/nexus/conversations/ask/route');
  return route.POST;
}

let post: Post;

beforeAll(async () => {
  post = await load('mock');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function ask(body: unknown): Promise<Response> {
  return post(
    new Request('http://nexus.test/api/nexus/conversations/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

async function frames(response: Response): Promise<Frame[]> {
  if (!response.body) throw new Error('the ask route answered with no stream to read');
  const out: Frame[] = [];
  for await (const message of readSse(response.body)) {
    out.push({ event: message.event, data: (message.data ?? {}) as Record<string, unknown> });
  }
  return out;
}

describe('mock mode — an offline answer that says it is offline', () => {
  it('answers for the merchant on the page without a session, and reports itself as a demo', async () => {
    const response = await ask({
      merchant_id: 'm-lung-yuen',
      merchant_slug: 'lung-yuen-kitchen',
      message: '週六晚上七點有位嗎？',
      locale: 'zh-HK',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-conversation-id')).toMatch(/^mock-conv-/);

    const events = await frames(response);
    expect(events.map((frame) => frame.event)).toEqual(['status', 'summary', 'done']);
    const summary = events.find((frame) => frame.event === 'summary')!.data;
    expect(String(summary.text)).toContain('龍苑 Kitchen');
    const done = events.find((frame) => frame.event === 'done')!.data;
    expect(done.provider, 'a demo answer must identify itself, or the UI labels it as grounded').toBe('demo');
    expect(done.degraded).toBe(true);
  });

  it('continues a mock conversation instead of minting a new id for every question', async () => {
    const response = await ask({
      merchant_id: 'm-lung-yuen',
      merchant_slug: 'lung-yuen-kitchen',
      message: '那週日呢？',
      conversation_id: 'mock-conv-abc123',
      locale: 'en',
    });
    expect(response.headers.get('x-conversation-id')).toBe('mock-conv-abc123');
    const summary = (await frames(response)).find((frame) => frame.event === 'summary')!.data;
    expect(String(summary.text)).toContain('Demo mode');
  });

  it('rejects an empty question before it reaches any branch', async () => {
    const response = await ask({ merchant_id: 'm-lung-yuen', message: '   ' });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('validation_error');
  });

  it('rejects a question with no merchant', async () => {
    const response = await ask({ message: '有人嗎？' });
    expect(response.status).toBe(422);
  });
});

describe('live mode — the write path needs a caller', () => {
  it('refuses a signed-out caller without touching the platform or the AI service', async () => {
    const live = await load('live');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await live(
      new Request('http://nexus.test/api/nexus/conversations/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ merchant_id: '00000000-0000-0000-0000-000000000001', message: '有位嗎？' }),
      }),
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('unauthorized');
    expect(fetchMock, 'a signed-out question reached an upstream service').not.toHaveBeenCalled();
  });
});
