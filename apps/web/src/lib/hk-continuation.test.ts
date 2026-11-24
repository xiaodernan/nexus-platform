import { describe, expect, it } from 'vitest';
import { mockGuides } from './mock';
import { hkContinuation } from './hk-continuation';

/** D1580 — the hub's way forward is derived from the real corpus, never a stale hand-kept claim. */
describe('HK continuation rail', () => {
  const guides = mockGuides('zh-HK');

  it('takes the newest chapters and numbers them by corpus position', () => {
    const rail = hkContinuation(guides, 8);
    expect(rail.total).toBe(guides.filter((g) => g.slug.startsWith('hk-')).length);
    expect(rail.total).toBeGreaterThanOrEqual(185);
    expect(rail.chapters).toHaveLength(8);
    expect(rail.chapters[0]?.number).toBe(rail.total - 7);
    expect(rail.chapters.at(-1)?.number).toBe(rail.total);
    expect(rail.chapters.at(-1)?.slug).toBe(guides.filter((g) => g.slug.startsWith('hk-')).at(-1)?.slug);
  });

  it('links every chapter one tap away and stays deterministic', () => {
    const a = hkContinuation(guides, 8);
    const b = hkContinuation(guides, 8);
    expect(a).toEqual(b);
    for (const c of a.chapters) {
      expect(c.href).toBe(`/guides/${c.slug}`);
      expect(c.title.length).toBeGreaterThan(0);
    }
    expect(new Set(a.chapters.map((c) => c.slug)).size).toBe(8);
  });

  it('degrades honestly on an empty or non-HK corpus', () => {
    expect(hkContinuation([], 8)).toEqual({ total: 0, chapters: [] });
    expect(hkContinuation([{ slug: 'rainy-day-hong-kong' } as never], 8).chapters).toEqual([]);
  });
});
