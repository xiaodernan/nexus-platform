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
    expect(DEMO_GUIDES.length).toBeGreaterThanOrEqual(65);
    const slugs = DEMO_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every chapter resolves through mockGuide by its own slug (the /guides read path)', () => {
    // One decorated pass, memoized — a mockGuides() call per slug is O(n²) re-enrichment
    // of the whole seeded catalogue; the assertion logic is unchanged.
    const bySlug = new Map(mockGuides().map((g) => [g.slug, g]));
    for (const guide of DEMO_GUIDES) {
      const found = bySlug.get(guide.slug);
      expect(found, guide.slug).not.toBeNull();
      expect(found?.slug).toBe(guide.slug);
    }
  });

  it('every HK-series chapter carries the synthetic-fixture framing sentence', () => {
    const series = DEMO_GUIDES.filter((g) => g.slug.startsWith('hk-') && g.category === 'activities');
    expect(series.length).toBeGreaterThanOrEqual(65);
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

  it('chapters LIV-LXV resolve and fragrance correctly', () => {
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

    const l57 = mockGuide('hk-taipo-wholesale-market-chronicle');
    expect(l57).not.toBeNull();
    expect(l57?.title).toContain('第五十七章');
    expect(l57?.title).toContain('大埔墟');
    expect(l57?.flags.demo).toBe(true);

    const l58 = mockGuide('hk-container-terminal-noon-chronicle');
    expect(l58).not.toBeNull();
    expect(l58?.title).toContain('第五十八章');
    expect(l58?.title).toContain('青衣');
    expect(l58?.flags.demo).toBe(true);

    const l59 = mockGuide('hk-yuen-long-shoemaker-shop-chronicle');
    expect(l59).not.toBeNull();
    expect(l59?.title).toContain('第五十九章');
    expect(l59?.title).toContain('元朗');
    expect(l59?.flags.demo).toBe(true);

    const l60 = mockGuide('hk-mong-kok-ping-li-grocery-chronicle');
    expect(l60).not.toBeNull();
    expect(l60?.title).toContain('第六十章');
    expect(l60?.title).toContain('旺角');
    expect(l60?.flags.demo).toBe(true);

    const l61 = mockGuide('hk-shenzhen-huanggang-night-gate-chronicle');
    expect(l61).not.toBeNull();
    expect(l61?.title).toContain('第六十一章');
    expect(l61?.title).toContain('皇崗');
    expect(l61?.flags.demo).toBe(true);

    const l62 = mockGuide('hk-shenzhen-luohu-night-market-chronicle');
    expect(l62).not.toBeNull();
    expect(l62?.title).toContain('第六十二章');
    expect(l62?.title).toContain('羅湖');
    expect(l62?.flags.demo).toBe(true);

    const l63 = mockGuide('hk-sham-shui-po-north-river-market-chronicle');
    expect(l63).not.toBeNull();
    expect(l63?.title).toContain('第六十三章');
    expect(l63?.title).toContain('深水埗');
    expect(l63?.flags.demo).toBe(true);

    const l64 = mockGuide('hk-man-kam-to-driver-chronicle');
    expect(l64).not.toBeNull();
    expect(l64?.title).toContain('第六十四章');
    expect(l64?.title).toContain('文錦渡');
    expect(l64?.flags.demo).toBe(true);

    const l65 = mockGuide('hk-man-kam-to-return-chronicle');
    expect(l65).not.toBeNull();
    expect(l65?.title).toContain('第六十五章');
    expect(l65?.title).toContain('浩明');
    expect(l65?.flags.demo).toBe(true);
  });
});
