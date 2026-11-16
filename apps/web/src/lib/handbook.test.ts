import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1119 — `/handbook` pins: both locales carry the manual, the page is a dict-driven server
 * artefact with no island, and the zh copy is Holy Traditional HK script (the census charges
 * it anyway; this file pins a few visible strings). D1207: the route is server-rendered per
 * request so the one-click zh ↔ en switch reaches the document everywhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const DICT = 'apps/web/src/lib/i18n/dict.ts';
const PAGE = 'apps/web/app/handbook/page.tsx';

describe('D1119 the /handbook manual', () => {
  it('both locales carry the complete manual (eyebrow, title, nine sections, tour)', () => {
    const dict = read(DICT);
    expect(dict).toContain("eyebrow: 'NEXUS · 簡明說明書'");
    expect(dict).toContain("eyebrow: 'NEXUS · THE HANDBOOK'");
    expect(dict).toContain('玩盡 NEXUS，三分鐘讀完的完整說明書');
    expect(dict).toContain('Own NEXUS in three minutes');
    expect(dict).toContain("id: 'quiz'");
    expect(dict).toContain("id: 'privacy'");
    // Nine sections per locale — each id appears twice when both blocks are present.
    for (const id of ['search', 'home', 'hkseries', 'quiz', 'daily', 'me', 'merchant', 'privacy', 'faq']) {
      expect((dict.match(new RegExp(`id: '${id}'`, 'g')) || []).length).toBe(2);
    }
  });

  it('the page is server-rendered per request, renders dict content, and offers a real search path', () => {
    const page = read(PAGE);
    // D1207: no force-static — every route resolves the locale cookie per request so the
    // one-click zh ↔ en switch reaches all documents, not just the dynamic ones.
    expect(page).not.toContain("force-static");
    expect(page).toContain("currentLocale()");
    expect(page).toContain('dict.handbook');
    expect(page).toContain('href="/search"');
    expect(page).toContain('copy.sections.map');
    expect(page).toContain('copy.tour.map');
    // No client island; no telemetry either.
    expect(page).not.toContain("'use client'");
    expect(page).not.toContain('analytics');
  });

  it('the StateGraph runbook figure renders under the ENGINE section, dict-carried both locales', () => {
    const dict = read(DICT);
    expect(dict).toContain("stategraphDiagram: {");
    expect(dict).toContain('引擎執行圖——StateGraph 的真圖');
    expect(dict).toContain('The engine’s execution graph — the real StateGraph');
    expect(dict).toContain('預設 planner');
    expect(dict).toContain('Default is planner');
    const page = read(PAGE);
    expect(page).toContain("section.id === 'stategraph'");
    expect(page).toContain('stategraphDiagram');
    expect(page).toContain('make_plan');
    expect(page).toContain('fanout');
    expect(page).toContain('serial loop');
  });

  it('the footer chrome links the handbook for both locales via dict.nav.handbook', () => {
    const chrome = read('apps/web/src/components/site-chrome.tsx');
    expect(chrome).toContain("href: '/handbook'");
    expect(chrome).toContain('dict.nav.handbook');
    const dict = read(DICT);
    expect(dict).toContain("handbook: '說明書'");
    expect(dict).toContain("handbook: 'Handbook'");
  });
});
