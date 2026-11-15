/**
 * D1185 — the chapter-plane parity pins. Every Hong Kong series chapter that ships in
 * DEMO_GUIDES must resolve through `mockGuide` (the same read path /guides/[slug] uses),
 * must carry the 合成敘事 framing sentence, and must exist for exactly its own slug.
 *
 * Why this exists: a seed that fails to compile or registers the wrong slug fails silently
 * into the not-found shell with a 200 — the guide derefs to null and the reader never knows
 * the chapter is missing. The series is the product; losing a chapter must redden a test.
 */

import { describe, expect, it } from 'vitest';

import { mockGuide, mockGuides } from './mock';
import { DEMO_GUIDES } from './mock/seed';

describe('HK series — every seeded chapter actually resolves', () => {
  it('DEMO_GUIDES holds at least fifty-four chapters, each with a unique slug', () => {
    expect(DEMO_GUIDES.length).toBeGreaterThanOrEqual(56);
    const slugs = DEMO_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every chapter resolves through mockGuide by its own slug (the /guides read path)', () => {
    for (const guide of DEMO_GUIDES) {
      const found = mockGuide(guide.slug);
      expect(found, guide.slug).not.toBeNull();
      expect(found?.slug).toBe(guide.slug);
    }
  });

  it('every HK-series chapter carries the synthetic-fixture framing sentence', () => {
    const series = DEMO_GUIDES.filter((g) => g.slug.startsWith('hk-') && g.category === 'activities');
    expect(series.length).toBeGreaterThanOrEqual(56);
    for (const guide of series) {
      const text = [guide.description, ...guide.body_blocks.map((b) => ('text' in b ? b.text : ''))].join(' ');
      expect(text, guide.slug).toContain('合成敘事');
    }
  });

  it('mockGuides() decorates every seed entry with resolvable card items — none crash the read', () => {
    const all = mockGuides();
    expect(all.length).toBe(DEMO_GUIDES.length);
    for (const guide of all) {
      const cards = guide.body_blocks.filter((b) => b.type === 'cards');
      expect(cards.length, guide.slug).toBeGreaterThan(0);
    }
  });

  it('chapters LIV, LV and LVI resolve and fragrance correctly', () => {
    const l54 = mockGuide('hk-sham-shui-po-fabric-chronicle');
    expect(l54).not.toBeNull();
    expect(l54?.title).toContain('第五十四章');
    expect(l54?.title).toContain('深水埗');
    expect(l54?.flags.demo).toBe(true);

    const l55 = mockGuide('hk-loko-ma-chau-barrier-chronicle');
    expect(l55).not.toBeNull();
    expect(l55?.title).toContain('第五十五章');
    expect(l55?.title).toContain('落馬洲');
    expect(l55?.flags.demo).toBe(true);

    const l56 = mockGuide('hk-yauma-tei-opera-supper-chronicle');
    expect(l56).not.toBeNull();
    expect(l56?.title).toContain('第五十六章');
    expect(l56?.title).toContain('油麻地');
    expect(l56?.flags.demo).toBe(true);
  });
});
