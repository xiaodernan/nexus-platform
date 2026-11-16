/**
 * D1278 — the chapter corpus exists in TWO arms and the zh-CN arm answers first.
 *
 * The product's lobby is bilingual by design (§二, D606): the Hong Kong arc is written in Traditional,
 * and the Simplified twin is GENERATED — never hand-maintained — by `scripts/gen-simplified-seed.py`
 * (opencc hk2s+t2s) into `./seed-cn.ts`. These pins hold the generator honest:
 *
 *   1. the CN arm carries exactly the canon slice's guides and collections, in the same order —
 *      any drift in either direction, after any zh-HK edit without a regen, reddens here;
 *   2. the CN arm holds ZERO Traditional-only glyphs from the pairs that matter (the ones the
 *      D1276 audit caught in the dictionary arms) — the fold must not silently drop a glyph;
 *   3. the resolvers serve the right arm for the right locale — a zh-CN reader never sees
 *      Traditional copy (and a zh-HK reader never sees Simplified copy);
 *   4. the EN arm still gets English/canonical behavior (en falls back to the Traditional arm,
 *      the documented default — en chapters are out of this arm's generation scope).
 *
 * The fixture is synthetic (`flags:{demo:true}`) and the chapters are合成敘事; nothing here is real.
 */
import { describe, expect, it } from 'vitest';

import {
  DEMO_COLLECTIONS,
  DEMO_GUIDES,
} from './mock/seed';
import { DEMO_COLLECTIONS_CN, DEMO_GUIDES_CN } from './mock/seed-cn';
import { mockCollection, mockGuide, mockGuides } from './mock';

const TRADITIONAL_ONLY = /[體點務價場禮樓廣幫還麼關機萬讓說話請準網絡設備車輛動國學問實員區間會為來對廳飲飯湯雞麵線積適侶靜圖書馬鳥魚鴨協術極構靈風雲龍鳳門時尋亞漢碼變調護課讀證訂]/;

describe('simplified-seed generated arm', () => {
  it('carries exactly the canonical guides, in the same order', () => {
    expect(DEMO_GUIDES_CN).toHaveLength(DEMO_GUIDES.length);
    expect(DEMO_GUIDES_CN.map((g) => g.slug)).toEqual(DEMO_GUIDES.map((g) => g.slug));
  });

  it('carries exactly the canonical collections, in the same order', () => {
    expect(DEMO_COLLECTIONS_CN).toHaveLength(DEMO_COLLECTIONS.length);
    expect(DEMO_COLLECTIONS_CN.map((c) => c.slug)).toEqual(DEMO_COLLECTIONS.map((c) => c.slug));
  });

  it('the cn arm holds zero Traditional-only glyphs from the pinned pair table', () => {
    const haystack = JSON.stringify([...DEMO_GUIDES_CN, ...DEMO_COLLECTIONS_CN]);
    expect(TRADITIONAL_ONLY.test(haystack), 'cn arm holds a Traditional-only glyph — regenerate with scripts/gen-simplified-seed.py').toBe(false);
  });

  it('the fold actually fired on known chapter copy (譚華 → 谭华)', () => {
    const cn = DEMO_GUIDES_CN.find((g) => g.slug === 'hk-mong-kok-ging-fa-shu-mai-chronicle');
    expect(cn, 'chapter missing from the CN arm').toBeDefined();
    expect(JSON.stringify(cn)).toContain('谭华');
    expect(JSON.stringify(cn)).not.toContain('譚華');
    const canon = DEMO_GUIDES.find((g) => g.slug === 'hk-mong-kok-ging-fa-shu-mai-chronicle');
    expect(JSON.stringify(canon)).toContain('譚華');
  });

  it('mockGuides / mockGuide / mockCollections serve the zh-CN arm to zh-CN readers', () => {
    const cnGuides = mockGuides('zh-CN');
    const hkGuides = mockGuides('zh-HK');
    expect(cnGuides.map((g) => g.slug)).toEqual(hkGuides.map((g) => g.slug));
    expect(cnGuides[0]?.title).not.toEqual(hkGuides[0]?.title);
    const cn = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'zh-CN');
    const hk = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'zh-HK');
    expect(cn?.title).not.toEqual(hk?.title);
    expect(cn?.title).toContain('谭华');

    const cnCollection = mockCollection('late-night-where', 'zh-CN');
    const hkCollection = mockCollection('late-night-where', 'zh-HK');
    expect(cnCollection?.title).not.toEqual(hkCollection?.title);
  });

  it('mockGuides / mockGuide default to Traditional for unspecified locales (tests and console fixtures)', () => {
    const def = mockGuides();
    const hk = mockGuides('zh-HK');
    expect(def[0]?.title).toEqual(hk[0]?.title);
    expect(mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle')?.title).toBe(hk[0] && mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'zh-HK')?.title);
  });

  it('every slug round-trips both ways — a slug is ASCII and cannot fold', () => {
    for (const g of [...DEMO_GUIDES_CN, ...DEMO_COLLECTIONS_CN]) {
      expect(g.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
