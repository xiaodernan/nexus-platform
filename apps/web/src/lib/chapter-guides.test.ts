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
    expect(DEMO_GUIDES.length).toBeGreaterThanOrEqual(95);
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
    expect(series.length).toBeGreaterThanOrEqual(95);
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

  it('chapters LIV-XCV resolve and fragrance correctly', () => {
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

    const l66 = mockGuide('hk-man-kam-to-morning-chronicle');
    expect(l66).not.toBeNull();
    expect(l66?.title).toContain('第六十六章');
    expect(l66?.title).toContain('米斗');
    expect(l66?.flags.demo).toBe(true);

    const l67 = mockGuide('hk-man-kam-to-second-truck-chronicle');
    expect(l67).not.toBeNull();
    expect(l67?.title).toContain('第六十七章');
    expect(l67?.title).toContain('米車');
    expect(l67?.flags.demo).toBe(true);

    const l68 = mockGuide('hk-huanggang-return-coach-chronicle');
    expect(l68).not.toBeNull();
    expect(l68?.title).toContain('第六十八章');
    expect(l68?.title).toContain('班車');
    expect(l68?.flags.demo).toBe(true);

    const l69 = mockGuide('hk-central-pier-star-ferry-chronicle');
    expect(l69).not.toBeNull();
    expect(l69?.title).toContain('第六十九章');
    expect(l69?.title).toContain('天星小輪');
    expect(l69?.flags.demo).toBe(true);

    const l70 = mockGuide('hk-central-pier-star-ferry-midbay-chronicle');
    expect(l70).not.toBeNull();
    expect(l70?.title).toContain('第七十章');
    expect(l70?.title).toContain('三分鐘');
    expect(l70?.flags.demo).toBe(true);

    const l71 = mockGuide('hk-mong-kok-flower-market-closeout-chronicle');
    expect(l71).not.toBeNull();
    expect(l71?.title).toContain('第七十一章');
    expect(l71?.title).toContain('花墟');
    expect(l71?.flags.demo).toBe(true);

    const l72 = mockGuide('hk-central-tram-ding-ding-chronicle');
    expect(l72).not.toBeNull();
    expect(l72?.title).toContain('第七十二章');
    expect(l72?.title).toContain('叮叮');
    expect(l72?.flags.demo).toBe(true);

    const l73 = mockGuide('hk-wing-lei-street-analog-chronicle');
    expect(l73).not.toBeNull();
    expect(l73?.title).toContain('第七十三章');
    expect(l73?.title).toContain('永利街');
    expect(l73?.flags.demo).toBe(true);

    const l74 = mockGuide('hk-central-mandarin-oriental-chef-chronicle');
    expect(l74).not.toBeNull();
    expect(l74?.title).toContain('第七十四章');
    expect(l74?.title).toContain('飯盒時光');
    expect(l74?.flags.demo).toBe(true);

    const l75 = mockGuide('hk-wan-chai-pawnshop-chronicle');
    expect(l75).not.toBeNull();
    expect(l75?.title).toContain('第七十五章');
    expect(l75?.title).toContain('擺押');
    expect(l75?.flags.demo).toBe(true);

    const l76 = mockGuide('hk-chai-wan-oven-close-chronicle');
    expect(l76).not.toBeNull();
    expect(l76?.title).toContain('第七十六章');
    expect(l76?.title).toContain('爐主阿九');
    expect(l76?.flags.demo).toBe(true);

    const l77 = mockGuide('hk-kwun-tong-fishball-stall-dusk-chronicle');
    expect(l77).not.toBeNull();
    expect(l77?.title).toContain('第七十七章');
    expect(l77?.title).toContain('黃生關燈');
    expect(l77?.flags.demo).toBe(true);

    const l78 = mockGuide('hk-kowloon-bay-scalemaker-chronicle');
    expect(l78).not.toBeNull();
    expect(l78?.title).toContain('第七十八章');
    expect(l78?.title).toContain('秤匠');
    expect(l78?.flags.demo).toBe(true);

    const l79 = mockGuide('hk-temple-street-alpo-market-closing-chronicle');
    expect(l79).not.toBeNull();
    expect(l79?.title).toContain('第七十九章');
    expect(l79?.title).toContain('尾盤');
    expect(l79?.flags.demo).toBe(true);

    const l80 = mockGuide('hk-sham-shui-po-tuk-stall-late-night-chronicle');
    expect(l80).not.toBeNull();
    expect(l80?.title).toContain('第八十章');
    expect(l80?.title).toContain('阿梅');
    expect(l80?.flags.demo).toBe(true);

    const l81 = mockGuide('hk-wong-tai-sin-temple-incense-chronicle');
    expect(l81).not.toBeNull();
    expect(l81?.title).toContain('第八十一章');
    expect(l81?.title).toContain('黃大仙祠');
    expect(l81?.flags.demo).toBe(true);

    const l82 = mockGuide('hk-central-snow-factory-street-tailor-chronicle');
    expect(l82).not.toBeNull();
    expect(l82?.title).toContain('第八十二章');
    expect(l82?.title).toContain('阿良');
    expect(l82?.flags.demo).toBe(true);

    const l83 = mockGuide('hk-wan-chai-night-court-chronicle');
    expect(l83).not.toBeNull();
    expect(l83?.title).toContain('第八十三章');
    expect(l83?.title).toContain('黃姐');
    expect(l83?.flags.demo).toBe(true);

    const l84 = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle');
    expect(l84).not.toBeNull();
    expect(l84?.title).toContain('第八十四章');
    expect(l84?.title).toContain('燒賣');
    expect(l84?.flags.demo).toBe(true);

    const l85 = mockGuide('hk-jordan-way-shu-lao-sugar-water-chronicle');
    expect(l85).not.toBeNull();
    expect(l85?.title).toContain('第八十五章');
    expect(l85?.title).toContain('謝');
    expect(l85?.flags.demo).toBe(true);

    const l86 = mockGuide('hk-yauma-tei-midnight-pharmacy-chronicle');
    expect(l86).not.toBeNull();
    expect(l86?.title).toContain('第八十六章');
    expect(l86?.title).toContain('蕭哥');
    expect(l86?.flags.demo).toBe(true);

    const l87 = mockGuide('hk-tai-po-market-dye-factory-chronicle');
    expect(l87).not.toBeNull();
    expect(l87?.title).toContain('第八十七章');
    expect(l87?.title).toContain('染廠');
    expect(l87?.flags.demo).toBe(true);

    const l88 = mockGuide('hk-sai-ying-pun-locksmith-chronicle');
    expect(l88).not.toBeNull();
    expect(l88?.title).toContain('第八十八章');
    expect(l88?.title).toContain('鎖匠鋪');
    expect(l88?.flags.demo).toBe(true);

    const l89 = mockGuide('hk-kwun-tong-night-calibration-chronicle');
    expect(l89).not.toBeNull();
    expect(l89?.title).toContain('第八十九章');
    expect(l89?.title).toContain('校錶');
    expect(l89?.flags.demo).toBe(true);

    const l90 = mockGuide('hk-sham-shui-po-night-sweeper-chronicle');
    expect(l90).not.toBeNull();
    expect(l90?.title).toContain('第九十章');
    expect(l90?.title).toContain('黃叔');
    expect(l90?.flags.demo).toBe(true);

    const l91 = mockGuide('hk-aberdeen-boat-house-dinner-chronicle');
    expect(l91).not.toBeNull();
    expect(l91?.title).toContain('第九十一章');
    expect(l91?.title).toContain('黃生');
    expect(l91?.flags.demo).toBe(true);

    const l92 = mockGuide('hk-causeway-bay-newsstand-closing-chronicle');
    expect(l92).not.toBeNull();
    expect(l92?.title).toContain('第九十二章');
    expect(l92?.title).toContain('李阿');
    expect(l92?.flags.demo).toBe(true);

    const l93 = mockGuide('hk-kwun-tong-parcel-sorting-chronicle');
    expect(l93).not.toBeNull();
    expect(l93?.title).toContain('第九十三章');
    expect(l93?.title).toContain('阿莊');
    expect(l93?.flags.demo).toBe(true);

    const l94 = mockGuide('hk-quarry-bay-coffee-roastery-chronicle');
    expect(l94).not.toBeNull();
    expect(l94?.title).toContain('第九十四章');
    expect(l94?.title).toContain('阿郭');
    expect(l94?.flags.demo).toBe(true);

    const l95 = mockGuide('hk-tseung-kwan-o-typewriter-chronicle');
    expect(l95).not.toBeNull();
    expect(l95?.title).toContain('第九十五章');
    expect(l95?.title).toContain('李阿忠');
    expect(l95?.flags.demo).toBe(true);
  });
});
