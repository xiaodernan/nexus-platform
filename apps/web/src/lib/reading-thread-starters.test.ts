import { describe, expect, it } from 'vitest';

import { mockGuides } from './mock';
import { relatedChapters, starterChapters } from './reading-thread';

/**
 * D1532 — where a reader with NO history starts.
 *
 * The thread needs a read-set and the radar needs a current chapter; a first-time visitor has
 * neither, and "start anywhere" is the answer that loses them. The hubs are the honest replacement:
 * the chapters that connect to the most other chapters, so any road back into the world is short.
 */

const guide = (slug: string, title: string, body: string) => ({
  slug, title, description: body, city: 'hong-kong', category: 'activities',
  body_blocks: [{ type: 'paragraph' as const, text: body }],
  generated_by: 'ai' as const, reviewed_by_human: false,
  published_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  flags: { demo: true },
});

// 'hub' shares a DIFFERENT word with each of a, b and c; a, b and c share nothing with each other.
const CORPUS = [
  guide('hub', '機架早餐', '機架 香港 清晨 午後 深夜'),
  guide('a', '叉燒午後', '香港 叉燒'),
  guide('b', '燒味晚餐', '午後 燒味'),
  guide('c', '糖水季节', '深夜 糖水'),
  guide('leaf', '完全無關的一章', '量子 潮沼 恆星'),
];

describe('starterChapters', () => {
  it('names the hubs — the chapters that connect to the most others', () => {
    const starters = starterChapters(CORPUS, { steps: 3 });
    expect(starters.map((entry) => entry.slug)).toEqual(['hub', 'a', 'b']);
    expect(starters[0]?.degree).toBe(3);
    expect(starters[0]?.href).toBe('/guides/hub');
  });

  it('never names a chapter that connects to nothing', () => {
    // 'leaf' shares no word with anything, so it is not a door a newcomer should be sent through.
    const starters = starterChapters(CORPUS, { steps: 5 });
    expect(starters.map((entry) => entry.slug)).not.toContain('leaf');
    expect(starters.map((entry) => entry.slug)).toEqual(['hub', 'a', 'b', 'c']);
  });

  it('is deterministic — the same corpus always names the same three doors', () => {
    const first = starterChapters(CORPUS, { steps: 3 });
    const second = starterChapters(CORPUS, { steps: 3 });
    expect(first).toEqual(second);
  });

  it('answers nothing for a corpus too small to have a hub', () => {
    expect(starterChapters([guide('only', '唯一', '唯一')], { steps: 3 })).toEqual([]);
    expect(starterChapters([], { steps: 3 })).toEqual([]);
  });

  it('orders by degree, then by slug', () => {
    const starters = starterChapters(CORPUS, { steps: 5 });
    const degrees = starters.map((entry) => entry.degree);
    expect([...degrees].sort((x, y) => y - x)).toEqual(degrees);
    expect(starters.map((entry) => entry.degree)).toEqual([3, 2, 2, 1]);
  });

  it('finds the real hubs in the shipped corpus', () => {
    const corpus = mockGuides('zh-HK');
    const starters = starterChapters(corpus, { steps: 3 });
    expect(starters).toHaveLength(3);
    expect(starters[0]?.degree).toBeGreaterThan(50);
    for (const entry of starters) {
      expect(entry.degree).toBeGreaterThan(0);
      expect(corpus.some((guide) => guide.slug === entry.slug)).toBe(true);
    }
    // a hub really is a hub: the radar from it finds neighbours.
    expect(relatedChapters(corpus, starters[0]?.slug ?? '', { steps: 1 }).length).toBe(1);
  });
});
