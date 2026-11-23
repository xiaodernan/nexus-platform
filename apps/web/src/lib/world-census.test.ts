import { describe, expect, it } from 'vitest';
import { mockGuides } from './mock';
import { endlessDoors, worldCensus } from './world-census';

/** D1560 — world size is derived, and finishing is a door not a dead end (§六). */
describe('world census', () => {
  const guides = mockGuides('zh-HK');

  it('derives real numbers from the corpus', () => {
    const c = worldCensus(guides);
    expect(c.chapters).toBe(guides.filter((g) => g.slug.startsWith('hk-')).length);
    expect(c.chapters).toBeGreaterThanOrEqual(182);
    expect(c.englishArms).toBe(c.chapters);
    expect(c.bodyBlocks).toBeGreaterThan(1000);
    expect(c.cardSets).toBeGreaterThan(0);
    expect(c.timeBands).toBeGreaterThanOrEqual(7);
    expect(c.layers).toBe(7);
  });

  it('is deterministic over the same corpus', () => {
    expect(worldCensus(guides)).toEqual(worldCensus(guides));
  });

  it('returns unvisited doors from different time bands', () => {
    const read = new Set(guides.slice(0, 178).map((g) => g.slug));
    const doors = endlessDoors(guides, read, 3);
    expect(doors.length).toBe(3);
    expect(doors.every((d) => !read.has(d.slug))).toBe(true);
    expect(new Set(doors.map((d) => d.slug)).size).toBe(3);
    expect(endlessDoors(guides, read, 3)).toEqual(doors);
  });

  it('never dead-ends even when every chapter is read', () => {
    const all = new Set(guides.map((g) => g.slug));
    const doors = endlessDoors(guides, all, 3);
    expect(doors.length).toBe(3);
  });
});
