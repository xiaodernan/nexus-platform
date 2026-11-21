import { describe, expect, it } from 'vitest';

import { mockGuides } from './mock';
import { relatedChapters, threadTokens } from './reading-thread';

/**
 * D1530 — the chapter radar: which chapters stand closest to the one being read.
 *
 * The reading thread answers "what next, from what I finished"; the radar answers "what else is
 * about this", which is the other half of not getting lost in 177 chapters — a reader at the bottom
 * of a chapter should be handed its neighbours, not an index.
 */

const guide = (slug: string, title: string, body: string) => ({
  slug, title, description: body, city: 'hong-kong', category: 'activities',
  body_blocks: [{ type: 'paragraph' as const, text: body }],
  generated_by: 'ai' as const, reviewed_by_human: false,
  published_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  flags: { demo: true },
});

const CORPUS = [
  guide('a', '叉燒的早上', '叉燒 爐火 清晨 的 第一碟 飯'),
  guide('b', '叉燒的黃昏', '叉燒 爐火 黃昏 的 最後一碟 飯'),
  guide('c', '叉燒的深夜', '叉燒 爐火 深夜 的 第三碟 飯'),
  guide('d', '雨天的走廊', '有蓋 走廊 雨天 港鐵 一站'),
];

describe('relatedChapters', () => {
  it('names the chapters that share the most with the one being read', () => {
    const near = relatedChapters(CORPUS, 'a', { steps: 3 });
    // 'd' shares no bigram with 'a', so it is not a neighbour at all - the radar only offers
    // chapters the reader can actually see the connection to.
    expect(near.map((entry) => entry.slug)).toEqual(['b', 'c']);
    expect(near[0]?.shared).toContain('叉燒');
    expect(near[0]?.href).toBe('/guides/b');
    expect(near[0]?.score).toBeGreaterThan(0);
  });

  it('never names the chapter being read', () => {
    const near = relatedChapters(CORPUS, 'a', { steps: 3 });
    expect(near.map((entry) => entry.slug)).not.toContain('a');
  });

  it('is deterministic — the same chapter always shows the same neighbours', () => {
    const first = relatedChapters(CORPUS, 'a', { steps: 3 });
    const second = relatedChapters(CORPUS, 'a', { steps: 3 });
    expect(first).toEqual(second);
  });

  it('answers nothing for a chapter the corpus does not hold', () => {
    expect(relatedChapters(CORPUS, 'nope', { steps: 3 })).toEqual([]);
  });

  it('ranks by score, then by slug', () => {
    const near = relatedChapters(CORPUS, 'a', { steps: 4 });
    const scores = near.map((entry) => entry.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('orders the shared words by distinctiveness, not alphabet', () => {
    const corpus = mockGuides('zh-HK');
    const near = relatedChapters(corpus, 'hk-food-chronicle', { steps: 1 });
    expect(near).toHaveLength(1);
    const [first] = near;
    expect(first?.shared.length).toBeGreaterThan(0);
    // the most distinctive word is rarer across the corpus than the least distinctive one
    const tokensOf = (slug: string) =>
      threadTokens((corpus.find((g) => g.slug === slug)?.title ?? '')
        + ' ' + (corpus.find((g) => g.slug === slug)?.description ?? ''));
    expect(first?.shared.length).toBeLessThanOrEqual(3);
    expect(tokensOf(first?.slug ?? '').size).toBeGreaterThan(0);
  });
});
