import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1268 — pins for the in-app /chronicle codex: the page is server-rendered, dict-carried
 * and canonical; both locales carry the three acts, the 105-chapter framing and the finale
 * CTAs; the footer carries the door.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/chronicle/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';
const DICT_CN = 'apps/web/src/lib/i18n/dict-cn.ts';

describe('D1268 the /chronicle framing codex', () => {
  it('the page is server-rendered, dict-carried, canonical /chronicle', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain('currentLocale()');
    expect(page).toContain("dict.chronicle");
    expect(page).toContain("canonical: '/chronicle'");
    expect(page).toContain('/hong-kong');
    expect(page).toContain("/stamp");
    expect(page).toContain('/handbook');
  });

  it('both locales carry the same three acts and the 105-chapter framing', () => {
    const dict = read(DICT);
    for (const key of ['acts', 'finaleTitle', 'ctaStory', 'ctaStamp']) {
      const hits = (dict.match(new RegExp(`${key}:`, 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2);
    }
    expect(dict).toContain('唐伯與阿璇的 N 巴士');
    expect(dict).toContain('陳老師與最後一遍板書');
    expect(dict).toContain('船長炳與最後一班船');
    expect(dict).toContain('三個章節');
    expect(dict).toContain('Three acts');
  });

  it('the footer carries the door (both locales)', () => {
    const chrome = read(CHROME);
    const dict = read(DICT);
    const dictCn = read(DICT_CN);
    expect(chrome).toContain('dict.footer.extraLinks');
    expect(dict).toContain("href: '/chronicle'");
    expect(dict).toContain('系列全書');
    expect(dict).toContain('The Chronicle');
    expect(dictCn).toContain('系列全书');
  });
});
