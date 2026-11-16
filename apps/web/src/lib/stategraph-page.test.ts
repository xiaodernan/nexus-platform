import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1246 — pins for the in-app StateGraph runbook route: the page is server-rendered and
 * dict-carried, both locales carry the four sections and the five-step rehearsal, the
 * island is local-only (no fetch, no storage, no timers), and the handbook wholly links
 * into it (CTA) while the footer carries the engine door.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/stategraph/page.tsx';
const ISLAND = 'apps/web/src/components/stategraph-island.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';
const HANDBOOK = 'apps/web/app/handbook/page.tsx';

describe('D1246 the /stategraph runbook page', () => {
  it('the page is server-rendered, dict-carried, canonical /stategraph', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain("currentLocale()");
    expect(page).toContain("dict.stategraph");
    expect(page).toContain("canonical: '/stategraph'");
    expect(page).toContain('<StateGraphIsland');
  });

  it('both locales carry the runbook (eyebrow, title, four sections, five steps)', () => {
    const dict = read(DICT);
    expect(dict).toContain("eyebrow: '引擎 · stategraph'");
    expect(dict).toContain("eyebrow: 'ENGINE · stategraph'");
    expect(dict).toContain('智能代理運行的一張圖');
    expect(dict).toContain('One graph, four nodes, one turn');
    for (const id of ['runbookTitle', 'rehearsalTitle', 'switchTitle', 'truthTitle']) {
      const hits = (dict.match(new RegExp(`${id}:`, 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2);
    }
    for (const title of ['① 計劃 · make_plan', '② 路由 · route', '③ 扇出 · fanout（並發）', '④ 組裝 · emit', '⑤ 完成 · done',
      '① Plan · make_plan', '② Route', '③ Fan-out (concurrent)', '④ Emit', '⑤ Done']) {
      expect(dict.includes(title)).toBe(true);
    }
  });

  it('the rehearsal island stores nothing; all actions are real buttons', () => {
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('onKeyDown');
    expect(island).toContain('<button');
    expect(island).toContain('resetCta');
  });

  it('the handbook teaches the runbook (CTA link) and the footer carries the engine door', () => {
    const handbook = read(HANDBOOK);
    expect(handbook).toContain('href="/stategraph"');
    expect(handbook).toContain('copy.stategraphDiagram.runbookCta');
    const chrome = read(CHROME);
    expect(chrome).toContain("href: '/stategraph'");
    expect(chrome).toContain('引擎讀本');
    expect(chrome).toContain('The engine');
    const dict = read(DICT);
    expect(dict).toContain('stategraphDiagram');
    expect(dict).toContain('runbookCta');
  });
});
