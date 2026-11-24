import { describe, expect, it } from 'vitest';
import { getDict } from './i18n';
import { layerCensus, layerIndexOf } from './layer-census';

/** D1600 — the /world layer statistics are derived from the 106 chips, never hand-written. */
describe('layer census', () => {
  const clock = getDict('zh-HK').home.hkHub.clock;
  const layers = getDict('zh-HK').world.layers;

  it('partitions every chip exactly once into the seven layers', () => {
    const c = layerCensus(clock, layers);
    expect(c.total).toBe(106);
    expect(c.rows).toHaveLength(7);
    expect(c.rows.map((r) => r.chapters)).toEqual([17, 20, 18, 21, 10, 10, 10]);
    expect(c.rows.reduce((n, r) => n + r.chapters, 0)).toBe(106);
    expect(c.rows.every((r) => r.share >= 0 && r.share <= 100)).toBe(true);
  });

  it('uses the same boundaries as the page', () => {
    expect(layerIndexOf('03:44')).toBe(0);
    expect(layerIndexOf('03:45')).toBe(1);
    expect(layerIndexOf('23:45')).toBe(6);
  });

  it('honestly reports zero chips', () => {
    expect(layerCensus([], layers)).toEqual({
      total: 0,
      rows: layers.map((l) => ({ code: l.code, title: l.title, chapters: 0, share: 0 })),
    });
  });
});
