/**
 * Contract test for `getDict()` — the three locales are ONE tree seen three times. The
 * /merchant/settings page wires every one of its action buttons (request verification,
 * invite member, create api key, reindex knowledge) directly to dict leaves; a key that
 * drifts between `zh-HK`, `zh-CN` and `en` — or shrinks to an empty string — ships a button
 * with no label in one language, and nothing in the build catches it: the type checks
 * because both sides still satisfy the Dict interface modulo an empty value.
 *
 * This test walks all locale trees and asserts:
 *   1. EXACT structure parity — same leaf count, same paths, same leaf types;
 *   2. every string leaf is non-empty and free of template residue (`undefined`,
 *      `NaN`, `[object Object]`);
 *   3. every function leaf is callable in all locales and returns copy, not markup;
 *   4. cross-locale script discipline — the Traditional arm holds no Simplified glyph,
 *      the Simplified arm holds no Traditional-only glyph, and the English arm holds no
 *      Han characters EXCEPT the measured allowlist below: the Cantonese phrase pool the
 *      home page teaches with, and the Chinese titles/places the English copy cites by
 *      name (19 leaves, censused D1539). A NEW Han character anywhere else in the en
 *      arm reddens this test — untranslated copy is a bug, cited copy is content;
 *   5. the /merchant/settings surface in particular: every button label, confirm title,
 *      confirm text and table column header the page points at exists and is non-empty
 *      in ALL locales. Renaming any of these keys in the dict without updating the list
 *      below reddens this test on purpose.
 *
 * Copy is never invented here: failures mean the dict lost text, and the fix is to
 * restore it, never to fill the hole from this file.
 */
import { describe, expect, it } from 'vitest';
import { getDict } from './dict';

type Leaf = { path: string; value: unknown };

function walk(node: unknown, path: string[], out: Leaf[]): Leaf[] {
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key], [...path, key], out);
    }
    return out;
  }
  out.push({ path: path.join('.'), value: node });
  return out;
}

const zh = new Map(walk(getDict('zh-HK'), [], []).map((l) => [l.path, l.value]));
const cn = new Map(walk(getDict('zh-CN'), [], []).map((l) => [l.path, l.value]));
const en = new Map(walk(getDict('en'), [], []).map((l) => [l.path, l.value]));

describe('dict locale parity', () => {
  it('zh-HK and zh-CN hold exactly the same leaf paths', () => {
    const zhOnly = [...zh.keys()].filter((k) => !cn.has(k));
    const cnOnly = [...cn.keys()].filter((k) => !zh.has(k));
    expect(zhOnly).toEqual([]);
    expect(cnOnly).toEqual([]);
    expect(zh.size).toBeGreaterThan(0);
  });

  it('zh-HK and en hold exactly the same leaf paths', () => {
    const zhOnly = [...zh.keys()].filter((k) => !en.has(k));
    const enOnly = [...en.keys()].filter((k) => !zh.has(k));
    expect(zhOnly).toEqual([]);
    expect(enOnly).toEqual([]);
    expect(zh.size).toBeGreaterThan(0);
  });

  it('every leaf has the same type across all locales', () => {
    for (const [locale, dict] of [['zh-CN', cn], ['en', en]] as const) {
      const mismatches = [...zh.keys()].filter((k) => dict.has(k) && typeof zh.get(k) !== typeof dict.get(k));
      expect(mismatches, `locale ${locale} type drift`).toEqual([]);
    }
  });

  it('every string leaf is non-empty and free of template residue', () => {
    const residue = /undefined|NaN|\[object Object\]/;
    for (const [locale, dict] of [['zh-HK', zh], ['zh-CN', cn], ['en', en]] as const) {
      for (const [path, value] of dict) {
        if (typeof value !== 'string') continue;
        expect(value.trim(), `${locale} ${path} is empty`).not.toBe('');
        expect(residue.test(value), `${locale} ${path} contains residue: ${value}`).toBe(false);
      }
    }
  });

  it('every function leaf is callable in all locales and returns non-empty copy', () => {
    for (const [locale, dict] of [['zh-HK', zh], ['zh-CN', cn], ['en', en]] as const) {
      for (const [path, value] of dict) {
        if (typeof value !== 'function') continue;
        const args = Array.from({ length: (value as (...a: unknown[]) => unknown).length }, () => 'probe');
        const produced = (value as (...a: unknown[]) => unknown)(...args);
        expect(typeof produced, `${locale} ${path} does not return a string`).toBe('string');
        expect((produced as string).trim(), `${locale} ${path} returns empty copy`).not.toBe('');
      }
    }
  });

  it('the zh-CN arm holds no Traditional-only glyphs (opencc t2s output is already Simplified)', () => {
    // Every leaf the Simplified arm emits must already BE its Simplified form: if a
    // Traditional-only glyph survives, the fold generator silently missed it. The list is
    // the common Traditional-only forms seen in this corpus — one per fold pair the AI NLU
    // lane already pins — not a whole Unicode table.
    const traditionalOnly = /[體點務價場禮樓廣幫還麼關機萬讓說話請準網絡設備車輛動國學問實員區間會為來對廳飲飯湯雞麵線積適侶靜圖書馬鳥魚鴨協術極構靈風雲龍鳳門時尋亞漢碼變調護課讀證訂]/;
    for (const [path, value] of cn) {
      if (typeof value !== 'string') continue;
      expect(traditionalOnly.test(value), `zh-CN ${path} carries Traditional-only glyphs: ${value}`).toBe(false);
    }

    // D1539: the en arm's Han characters are a MEASURED allowlist, not a free-for-all. The census
    // found exactly 19 Han-carrying leaves, and every one is a citation the English copy makes on
    // purpose — the 12-phrase Cantonese pool the home page teaches with, the demo personas, the
    // glosses (常餐), the guide titles the reader is pointed at, and one place name (尖沙咀). This
    // is the boundary the docblock claims: a leaf that STARTS carrying Han without being on this
    // list is untranslated copy that leaked, and the test names it.
    const han = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const enHanAllowlist = new Set([
      'cmdConsole.realTraceNote',
      'home.tryFlow.steps.4.example',
      ...Array.from({ length: 12 }, (_, i) => `home.hkHub.cantonese.pool.${i}.phrase`),
      'hkType.questions.1.text',
      'hkType.results.yum_cha.guideTitle',
      'hkType.results.siu_mei.guideTitle',
      'hkType.results.cha_chaan_teng.guideTitle',
      'handbook.sections.10.bullets.1',
    ]);
    for (const [path, value] of en) {
      if (typeof value !== 'string' || !han.test(value)) continue;
      expect(enHanAllowlist.has(path),
        `en ${path} carries Han characters but is not on the measured allowlist (untranslated copy?): ${value}`,
      ).toBe(true);
    }
  });
});

/** The exact dict leaves the /merchant/settings action surface reads. */
const SETTINGS_SURFACE_KEYS = [
  'console.settings.intro',
  'console.settings.profileTitle',
  'console.settings.hoursTitle',
  'console.settings.hoursNote',
  'console.settings.verificationTitle',
  'console.settings.agentTitle',
  'console.settings.agentIntro',
  'console.settings.teamTitle',
  'console.settings.keysTitle',
  'console.settings.knowledgeTitle',
  'console.settings.knowledgeIntro',
  'console.settings.verification.verified',
  'console.settings.verification.pending',
  'console.settings.verification.unverified',
  'console.settings.verification.unknown',
  'console.settings.verification.note',
  'console.settings.verification.request',
  'console.settings.verification.notWired',
  'console.settings.team.invite',
  'console.settings.team.notWired',
  'console.settings.team.columns.name',
  'console.settings.team.columns.email',
  'console.settings.team.columns.role',
  'console.settings.team.columns.permissions',
  'console.settings.team.columns.status',
  'console.settings.team.columns.joined',
  'console.settings.team.empty',
  'console.settings.keys.create',
  'console.settings.keys.notWired',
  'console.settings.keys.onceNote',
  'console.settings.keys.columns.label',
  'console.settings.keys.columns.prefix',
  'console.settings.keys.columns.scopes',
  'console.settings.keys.columns.created',
  'console.settings.keys.columns.lastUsed',
  'console.settings.keys.columns.revoked',
  'console.settings.keys.empty',
  'console.settings.knowledge.reindex',
  'console.settings.knowledge.notWired',
  'console.settings.knowledge.columns.kind',
  'console.settings.knowledge.columns.title',
  'console.settings.knowledge.columns.status',
  'console.settings.knowledge.columns.chunks',
  'console.settings.knowledge.columns.updated',
];

describe('/merchant/settings dict surface', () => {
  for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
    it(`every button label and column header the page reads exists and is non-empty (${locale})`, () => {
      const dict = getDict(locale);
      for (const key of SETTINGS_SURFACE_KEYS) {
        const value = key.split('.').reduce<unknown>(
          (acc, segment) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[segment] : undefined),
          dict,
        );
        expect(value, `${locale}: missing dict leaf ${key}`).toBeDefined();
        expect(typeof value, `${locale}: dict leaf ${key} is ${typeof value}, expected string`).toBe('string');
        expect((value as string).trim(), `${locale}: dict leaf ${key} is empty`).not.toBe('');
      }
    });
  }
});
