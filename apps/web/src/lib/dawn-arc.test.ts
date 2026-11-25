import { describe, expect, it } from 'vitest';
import { mockGuide } from './mock';
import { dawnArcFor, DAWN_ARC_SLUGS } from './dawn-arc';

/** D1612 — the dawn arc is a curated six-chapter path from midnight to half past five. */
describe('dawn arc', () => {
  it('names six shipped chapters in clock order', () => {
    expect(DAWN_ARC_SLUGS).toHaveLength(6);
    for (const slug of DAWN_ARC_SLUGS) {
      expect(mockGuide(slug, 'zh-HK')?.slug, `missing ${slug}`).toBe(slug);
      expect(mockGuide(slug, 'en')?.slug, `missing EN arm ${slug}`).toBe(slug);
    }
    expect(DAWN_ARC_SLUGS[0]).toBe('hk-vending-machine-chronicle');
    expect(DAWN_ARC_SLUGS.at(-1)).toBe('hk-central-dawn-blank-sheet-chronicle');
  });

  it('gives null-safe neighbours at the two ends', () => {
    const first = dawnArcFor(DAWN_ARC_SLUGS[0]!);
    expect(first?.step).toBe(1);
    expect(first?.total).toBe(6);
    expect(first?.prev).toBeNull();
    const last = dawnArcFor(DAWN_ARC_SLUGS[5]!);
    expect(last?.step).toBe(6);
    expect(last?.next).toBeNull();
    expect(dawnArcFor('hk-mong-kok-ging-fa-shu-mai-chronicle')).toBeNull();
  });
});
