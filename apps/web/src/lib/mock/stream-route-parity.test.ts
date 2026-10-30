/**
 * D641 / STATUS §638 — one prompt, either script, through the seam a browser actually crosses.
 *
 * `search-relevance.test.ts` proves the parity inside the data plane: same query, either script, same
 * cards. That is not the whole claim. The page does not call `mockSearch`; it POSTs to
 * `app/api/nexus/ai/stream/route.ts`, which reads the body, chooses the mock or live branch, frames the
 * events as SSE, and hands the bytes to `readSse`. Anything on that stretch of road — a handler that
 * rewrites or normalises the query, a body field the client never sends, a branch that answers the demo
 * from a different input — leaves the data-plane witness green while the reader still gets an empty
 * results page for the copy the home page itself offers. So this file asks the shipped question, in both
 * spellings, of the shipped handler.
 *
 * The mode is pinned, not inherited. `IS_MOCK` is a module-load constant in `src/lib/env.ts`, so
 * `NEXT_PUBLIC_DATA_MODE` is stubbed BEFORE the dynamic import below; a test file that imported the route
 * statically would freeze whichever mode the machine's `.env.local` happens to hold, and a lane that sets
 * `live` would have this witness ask a real :8010 for a demo answer — or, worse, read the `error` frame
 * that the live branch emits when nothing is listening and call the parity satisfied. Two clauses make
 * that unreachable: the `done` frame must say `provider: mock`, and no frame may be an `error`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { examplePrompts } from '../prompts';
import { readSse } from '../sse';
import { SIMPLIFIED_TWINS } from './simplified-twins';

type Post = (request: Request) => Promise<Response>;

let post: Post;

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'mock');
  const route = await import('../../../app/api/nexus/ai/stream/route');
  post = route.POST;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

interface Streamed {
  events: string[];
  slugs: string[];
  scores: Array<number | null>;
  rawQuery: string | null;
  provider: string | null;
  error: string | null;
}

/** POST one query through the handler and read every frame the shipped parser reads. */
async function ask(query: string): Promise<Streamed> {
  const response = await post(
    new Request('http://nexus.test/api/nexus/ai/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        conversation_id: null,
        previous_intent: null,
        geo: null,
        locale: 'zh-HK',
        force_error: false,
      }),
    }),
  );
  const out: Streamed = { events: [], slugs: [], scores: [], rawQuery: null, provider: null, error: null };
  if (!response.body) {
    throw new Error(`POST /api/nexus/ai/stream answered "${query}" with status ${response.status} and no body to read`);
  }
  for await (const message of readSse(response.body)) {
    out.events.push(message.event);
    const data = (message.data ?? {}) as Record<string, unknown>;
    if (message.event === 'intent') out.rawQuery = typeof data.raw_query === 'string' ? data.raw_query : null;
    if (message.event === 'results') {
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const card = item as { slug?: string; ai_match?: { score?: number } | null };
        out.slugs.push(card.slug ?? '(a card with no slug)');
        out.scores.push(typeof card.ai_match?.score === 'number' ? card.ai_match.score : null);
      }
    }
    if (message.event === 'error') out.error = `${String(data.code)}: ${String(data.message)}`;
    if (message.event === 'done') out.provider = typeof data.provider === 'string' ? data.provider : null;
  }
  return out;
}

describe('POST /api/nexus/ai/stream — one prompt, either script (D641)', () => {
  it('serves the stream from the mock plane in-process, so this witness is not reading a live service', async () => {
    const shipped = examplePrompts('zh-HK')[0];
    expect(shipped, 'the zh-HK starter prompts are gone, so the parity legs below would measure nothing').toBeTruthy();
    const streamed = await ask(shipped!.query);
    expect(streamed.error, `the stream carried an error frame instead of results: ${streamed.error}`).toBeNull();
    expect(streamed.events, 'no results frame was written').toContain('results');
    expect(streamed.provider, 'the route took the live branch, so IS_MOCK was not pinned before the import').toBe('mock');
    expect(streamed.rawQuery, 'the handler changed the query before the matcher saw it').toBe(shipped!.query);
  });

  for (const prompt of examplePrompts('zh-HK')) {
    it(`"${prompt.key}" returns the same cards in the same order whichever script it is typed in`, async () => {
      const twin = SIMPLIFIED_TWINS[prompt.key];
      expect(twin, 'prompts.ts grew a starter prompt with no Simplified twin in ./simplified-twins').toBeTruthy();
      const traditional = await ask(prompt.query);
      const simplified = await ask(twin!);
      const problems: string[] = [];
      for (const [script, streamed] of [['zh-HK', traditional], ['typed Simplified', simplified]] as const) {
        if (streamed.error) problems.push(`${script}: error frame ${streamed.error}`);
        // Parity over two empty pages is the defect wearing a green badge.
        if (streamed.slugs.length === 0) problems.push(`${script}: the results frame carried no cards at all`);
        if (streamed.rawQuery === null) problems.push(`${script}: no intent frame, so the query never reached the matcher`);
      }
      if (traditional.slugs.length > 0 && simplified.slugs.length > 0) {
        if (traditional.slugs.join(',') !== simplified.slugs.join(',')) {
          problems.push(`different cards, either order:\n  traditional: ${traditional.slugs.join(', ')}\n  simplified:  ${simplified.slugs.join(', ')}`);
        }
        if (traditional.scores.join(',') !== simplified.scores.join(',')) {
          problems.push(`same cards, different match scores:\n  traditional: ${traditional.scores.join(', ')}\n  simplified:  ${simplified.scores.join(', ')}`);
        }
      } else {
        problems.push('card lists not compared, because one side was empty');
      }
      expect(problems, `the shipped route answered "${prompt.query}" and its twin "${twin}" differently:\n${problems.join('\n')}`).toEqual([]);
    });
  }
});
