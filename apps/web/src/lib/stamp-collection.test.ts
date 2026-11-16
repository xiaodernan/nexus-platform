import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1177 — pin the Stamp Collection page + island.
 *
 *   - the island is a client island that reads `nexus.hk-series.read` for its source of truth;
 *   - the page is server-rendered per request, no network, both locales dict-carried
 *     (D1207: no force-static so the one-click zh ↔ en switch reaches this document too);
 *   - the route compiles and renders the full 50 hrefs in SSR (everything-always-hydrates pattern);
 *   - the footer carries its link in both locales
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/stamp-collection.tsx';
const PAGE = 'apps/web/app/stamp/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';
const DICT_CN = 'apps/web/src/lib/i18n/dict-cn.ts';

describe('D1177 /stamp collection island', () => {
  it('stamp source-of-truth is the same nexus.hk-series.read the progress strip uses', () => {
    const src = read(COMPONENT);
    const helper = read('apps/web/src/lib/chapter-read.ts');
    expect(helper).toContain("CHAPTER_READ_KEY = 'nexus.hk-series.read'");
    expect(helper).toContain('readChapters');
    expect(src).toContain('readChapters');
    expect(src).toContain('slugFromGuideHref');
    expect(src).toContain("'use client'");
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('XMLHttpRequest');
  });

  it('page is server-rendered per request and renders the same island for both locales', () => {
    const page = read(PAGE);
    // D1207: no force-static — the locale cookie must be honored per request on this route too.
    expect(page).not.toContain("force-static");
    expect(page).toContain("currentLocale()");
    expect(page).toContain('StampCollection');
    expect(page).toContain('canonical: \'/stamp\'');
  });

  it('dict carries the stamp block in both locales with zero English leftover in zh', () => {
    const dict = read(DICT);
    expect(dict).toContain('印章之旅 · STAMPS ON PASSPORTS');
    expect(dict).toContain('STAMPS ON A PASSPORT');
    expect(dict).toContain('每讀一章，就等於在護照上敲一個章印');
    expect(dict).toContain('Every chapter stamps your passport');
  });

  it('footer points to /stamp in both locales', () => {
    const chrome = read(CHROME);
    const dict = read(DICT);
    const dictCn = read(DICT_CN);
    expect(chrome).toContain('dict.footer.extraLinks');
    expect(dict).toContain("'/stamp'");
    expect(dict).toContain('印章收集');
    expect(dict).toContain('Passport stamps');
    expect(dictCn).toContain('印章收集');
  });

  it('dict carries the printable certificate blocks in both locales', () => {
    const dict = read(DICT);
    expect(dict).toContain("completeKicker: '終章獎 — 天下無雙'");
    expect(dict).toContain("completeKicker: 'The final seal — THE COMPLETE PASSPORT'");
    expect(dict).toContain("completeWax: '香港終日 · 八十七章讀竟'");
    expect(dict).toContain("completeWax: 'Hong Kong — eighty-seven chapters, one pass'");
    expect(dict).toContain("completeButton: '印一枚蠟印'");
    expect(dict).toContain("completeButton: 'Print the wax seal'");
    expect(dict).toContain('八十七章香港系列');
    expect(dict).toContain('Eighty-seven chapters, eighty-seven stamps');
    expect(dict).not.toContain('五十章香港系列');
    expect(dict).not.toContain('Fifty chapters, fifty stamps');
  });

  it('the island renders the seal behind the allDone gate and SSR passes the HK date in', () => {
    const src = read(COMPONENT);
    expect(src).toContain('currentDate');
    expect(src).toContain('window.print()');
    expect(src).toContain('printable-root');
    expect(src).toContain('id="stamp-certificate"');
    const page = read(PAGE);
    expect(page).toContain('currentDate={hkDate}');
    expect(page).toContain('en-CA');
    expect(page).toContain("timeZone: 'Asia/Shanghai'");
  });
});
