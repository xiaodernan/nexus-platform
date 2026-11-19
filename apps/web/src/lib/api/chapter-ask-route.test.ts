/**
 * D1284 — the chapter-companion lane, pinned.
 *
 * MOCK MODE is asserted exactly: `NEXT_PUBLIC_DATA_MODE=mock` must return
 * `degraded:true, reason:'mock_provider'` with an EMPTY answer — never a call, never a pretend.
 *
 * LIVE MODE is asserted on its seam contract: with the platform read and the AI read wired to
 * a branching spy, the model must receive exactly the top excerpts of THIS chapter (each ≤1600
 * chars, ids p<N>), the upstream's `measured` block must pass through, and any failure must
 * degrade to an empty answer — the page keeps the deterministic render and nothing else.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Post = (request: Request) => Promise<Response>;

async function load(mode: 'mock' | 'live'): Promise<Post> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode);
  const route = await import('../../../app/api/nexus/ai/chapter-ask/route');
  return route.POST as Post;
}

function request(body: unknown): Request {
  return new Request('http://nexus.test/api/nexus/ai/chapter-ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const PLATFORM_GUIDE = {
  slug: 'hk-cha-chaan-teng-dawn',
  title: '茶餐廳・早朝',
  description: '六點鐘的茶餐廳，收音機雜音裡的新聞。',
  city: 'Hong Kong',
  category: 'RECURRENT',
  body_blocks: [
    { type: 'paragraph', text: '凌晨六點，炒鑊的火比捲閘早醒半小時。' },
    { type: 'paragraph', text: '張生照舊坐最後一個卡位，翻開蘋果日報，點了杯齋啡同一隻水煮蛋。' },
    { type: 'paragraph', text: '收音機卡在同一個商業台，主播的聲音比人聲還要近。' },
  ],
  generated_by: 'editor',
  reviewed_by_human: true,
  published_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  flags: { demo: true },
};

const AI_REPLY = {
  answer: '張生係舊客：坐最後一卡位，飲齋啡，睇蘋果日報 [p2].',
  citations: [{ id: 'p2', title: '茶餐廳・早朝 · §2' }],
  confidence: 'high',
  degraded: false,
  measured: { latency_ms: 5200, prompt_tokens: 900, completion_tokens: 60, cached_tokens: 400, cache_reported: true },
};

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
    const fetchSpy = vi.fn(async () => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: '黃生係邊個？', chapterSlug: 'hk-cha-chaan-teng-dawn', locale: 'zh-HK' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('mock_provider');
    expect(body.answer).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('live mode is a grounded seam, never a shortcut', () => {
  let post: Post;

  beforeAll(async () => {
    post = await load('live');
  });

  function branchingSpy() {
    return vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/api/v1/guides/')) {
        return new Response(JSON.stringify(PLATFORM_GUIDE), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(JSON.stringify(AI_REPLY), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
  }

  it('forwards the chapter excerpts and passes measured values through verbatim', async () => {
    const fetchSpy = branchingSpy();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: '黃生係邊個？', chapterSlug: 'hk-cha-chaan-teng-dawn', locale: 'zh-HK' }));
    expect(res.status).toBe(200);

    const aiCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/ai/v1/chapter/ask'));
    expect(aiCall).toBeDefined();
    const init = aiCall![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as {
      chapter_id: string;
      chapter_title: string;
      sections: Array<{ id: string; body: string }>;
    };
    expect(sent.chapter_id).toBe('hk-cha-chaan-teng-dawn');
    expect(sent.sections.length).toBeGreaterThan(0);
    expect(sent.sections.length).toBeLessThanOrEqual(12);
    for (const s of sent.sections) {
      expect(s.id).toMatch(/^p[0-9]+$/);
      expect(s.body.length).toBeLessThanOrEqual(1600);
    }

    const parsed = await res.json();
    expect(parsed.degraded).toBe(false);
    expect(parsed.measured.prompt_tokens).toBe(900);
    expect(parsed.measured.cached_tokens).toBe(400);
  });

  it('degrades to an empty answer when the AI service is unreachable (the chapter stands)', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/api/v1/guides/')) {
        return new Response(JSON.stringify(PLATFORM_GUIDE), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return Promise.reject(new TypeError('upstream_unreachable'));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: '黃生係邊個？', chapterSlug: 'hk-cha-chaan-teng-dawn', locale: 'zh-HK' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.answer).toBe('');
  });

  it('returns chapter_not_found when the chapter does not exist (the island renders nothing)', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u.includes('/api/v1/guides/')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify(AI_REPLY), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(request({ question: '黃生係邊個？', chapterSlug: 'no-such-chapter', locale: 'zh-HK' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('chapter_not_found');
  });
});
