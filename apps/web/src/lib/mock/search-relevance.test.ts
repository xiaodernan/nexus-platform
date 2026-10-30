import { describe, expect, it } from 'vitest';
import type { EntityCard } from '@nexus/ui/trust/types';
import { examplePrompts } from '../prompts';
import { mockSearch } from './index';
import { SIMPLIFIED_TWINS } from './simplified-twins';

/**
 * CJK relevance regression for the mock data plane (§6).
 *
 * Chinese is not space-separated, so the whole starter prompt used to arrive as one token and
 * `haystack.includes('帮我找附近适合朋友聚会的餐厅')` was false for every merchant: relevance 0,
 * below the §6 floor, dropped. The demo returned an empty results page for its own example
 * prompts — the copy in `lib/prompts.ts` is exactly what a reviewer types first.
 *
 * These tests drive `mockSearch` (public behaviour), never `queryTokens` / `matchesQuery`, so the
 * tokenizer internals stay free to change underneath them.
 */

/** Every fact a card renders must be resolvable and attributable (§19, AGENT_CONTRACT §4). */
function expectFactsIntact(card: EntityCard) {
  const facts = card.facts ?? [];
  expect(facts.length, `${card.title} rendered with no facts at all`).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const fact of facts) {
    expect(fact.fact_id, `${card.title} has a fact without an id`).toBeTruthy();
    expect(fact.attribute, `${card.title}/${fact.fact_id} has no attribute`).toBeTruthy();
    expect(['merchant', 'imported', 'observed', 'third_party', 'inferred', 'demo']).toContain(fact.source);
    expect(fact.confidence).toBeGreaterThanOrEqual(0);
    expect(fact.confidence).toBeLessThanOrEqual(1);
    expect(Number.isNaN(Date.parse(fact.observed_at)), `${fact.fact_id} has no valid observed_at`).toBe(false);
    expect(seen.has(fact.fact_id), `${card.title} repeats fact_id ${fact.fact_id}`).toBe(false);
    seen.add(fact.fact_id);
  }
}

const FRIENDS_DINNER = '帮我找附近适合朋友聚会的餐厅';
const JAPANESE_BUDGET = '预算 300 港币，想吃日料';
/** No merchant, tag, subcategory or district shares a single token with this string. */
const NONSENSE = 'zzzqqq不存在的东西xx';

describe('mockSearch — unspaced CJK queries (§6 relevance)', () => {
  it('returns results for the friends-gathering prompt instead of an empty page', () => {
    const response = mockSearch({ query: FRIENDS_DINNER });
    expect(response.items.length, `${FRIENDS_DINNER} was thrown away by the relevance floor`).toBeGreaterThan(0);
    for (const card of response.items) expectFactsIntact(card);
  });

  it('returns results for the budget + 日料 prompt, and honours the stated budget', () => {
    const response = mockSearch({ query: JAPANESE_BUDGET });
    expect(response.items.length, `${JAPANESE_BUDGET} was thrown away by the relevance floor`).toBeGreaterThan(0);
    for (const card of response.items) {
      expectFactsIntact(card);
      expect(Number(card.price?.amount), `${card.title} ignores the 300 HKD ceiling`).toBeLessThanOrEqual(300);
    }
    expect(response.items.map((card) => card.slug)).toContain('ramen-koji');
  });

  it('serves every zh-HK starter prompt the home page offers', () => {
    const starved = examplePrompts('zh-HK')
      .map((prompt) => ({ query: prompt.query, items: mockSearch({ query: prompt.query }).items }))
      .filter((entry) => entry.items.length === 0)
      .map((entry) => entry.query);
    expect(starved, `starter prompts that render an empty results page:\n${starved.join('\n')}`).toEqual([]);
    for (const prompt of examplePrompts('zh-HK')) {
      for (const card of mockSearch({ query: prompt.query }).items) expectFactsIntact(card);
    }
  });

  it('still drops a query nothing matches instead of ranking by popularity', () => {
    const nonsense = mockSearch({ query: NONSENSE });
    expect(nonsense.items, `"${NONSENSE}" should score a complete miss on every merchant`).toEqual([]);
    expect(nonsense.items.length).toBeLessThan(mockSearch({ query: FRIENDS_DINNER }).items.length);
  });

  it('uses a coarse centre for distance, not as a hard radius the visitor never asked for', () => {
    // The route layer always supplies a centre (Central by default). Treating that as "within 3 km"
    // hid every result for four of the five starter prompts, because the demo catalogue is spread
    // across Kowloon and the New Territories.
    const central = { lat: 22.2817, lng: 114.1585 };
    expect(mockSearch({ query: JAPANESE_BUDGET, geo: central }).items.length, 'a default centre must not filter').toBeGreaterThan(0);
    // An explicit 附近 does mean a radius, and the nearest candidate must win the ordering.
    const nearby = mockSearch({ query: FRIENDS_DINNER, geo: central }).items;
    expect(nearby.length).toBeGreaterThan(0);
    const meters = nearby.map((card) => card.distance?.meters ?? Infinity);
    expect(meters.every((value) => value <= 3000), 'near_me results must stay inside the stated radius').toBe(true);
    expect([...meters].sort((a, b) => a - b)).toEqual(meters);
  });
});

/**
 * D641 / STATUS §638 — the mock plane answered a Traditional query with NOTHING.
 *
 * `lib/prompts.ts` offers 週末找一個適合情侶約會的地方; its matcher vocabulary cued 约会 and 餐厅 in the
 * Simplified script only, so the query produced no scene token and no category and fell below the §6
 * relevance floor. `vocabulary-spelling.test.ts` censuses the cue lists for that; this block measures the
 * thing the reader actually sees: the same prompt, typed either way, must return the same page. The twins
 * themselves live in `./simplified-twins`, shared with `stream-route-parity.test.ts`, which asks the same
 * question through the shipped `POST /api/nexus/ai/stream`.
 */

describe('mockSearch — one prompt, either script (D641)', () => {
  it('the twin list is the shipped prompt list, and each twin is a different spelling', () => {
    const shipped = examplePrompts('zh-HK');
    expect(Object.keys(SIMPLIFIED_TWINS).sort(), 'the twin list and prompts.ts no longer hold the same keys')
      .toEqual(shipped.map((prompt) => prompt.key).sort());
    const problems: string[] = [];
    for (const prompt of shipped) {
      const twin = SIMPLIFIED_TWINS[prompt.key];
      const trad = new Set([...prompt.query]);
      const simp = new Set([...(twin ?? '')]);
      const onlyTrad = [...trad].filter((c) => !simp.has(c));
      const onlySimp = [...simp].filter((c) => !trad.has(c));
      // Both directions: a twin that merely adds a Simplified character to the Traditional string would
      // share every one of its own characters with the query it is supposed to be an alternative to.
      if (onlyTrad.length === 0 || onlySimp.length === 0) {
        problems.push(`${prompt.key}: not two spellings of one query (only in shipped: ${onlyTrad.join('') || '—'} / only in twin: ${onlySimp.join('') || '—'})`);
      }
    }
    expect(problems, `the fixture restates rather than respells:\n${problems.join('\n')}`).toEqual([]);
  });

  it('returns the same cards, in the same order, whichever script the prompt is typed in', () => {
    const problems: string[] = [];
    for (const prompt of examplePrompts('zh-HK')) {
      const twin = SIMPLIFIED_TWINS[prompt.key] as string;
      const traditional = mockSearch({ query: prompt.query }).items;
      const simplified = mockSearch({ query: twin }).items;
      // Parity over two empty pages is the defect wearing a green badge, so both sides are counted first.
      if (traditional.length === 0) problems.push(`${prompt.key}: the shipped zh-HK prompt returns nothing — parity would compare two empty pages`);
      if (simplified.length === 0) problems.push(`${prompt.key}: its Simplified twin "${twin}" returns nothing (the §638 shape: one-script cues fall below the relevance floor)`);
      const byScript = (cards: typeof traditional) => cards.map((card) => card.slug).join(',');
      if (byScript(traditional) !== byScript(simplified)) {
        problems.push(`${prompt.key}: different cards\n    shipped: ${byScript(traditional)}\n    twin:    ${byScript(simplified)}`);
      }
      const scores = (cards: typeof traditional) => cards.map((card) => card.ai_match?.score ?? 'none').join(',');
      if (scores(traditional) !== scores(simplified)) {
        problems.push(`${prompt.key}: the two spellings score the same cards differently\n    shipped: ${scores(traditional)}\n    twin:    ${scores(simplified)}`);
      }
    }
    expect(problems, `the scripts do not agree:\n${problems.join('\n')}`).toEqual([]);
  });
});
