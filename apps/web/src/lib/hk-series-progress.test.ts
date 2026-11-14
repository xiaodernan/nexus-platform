import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1114 — the /hong-kong mega hub's local-first reading progress strip. Source-level pins;
 * the island's state machine is React/JS in the browser, the same category as
 * hk-type.test.ts; behavioral reachability lives in the e2e lane.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/hk-series-progress.tsx';
const HUB = 'apps/web/app/hong-kong/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1114 HK series reading-progress island', () => {
  it('is a client island that persists only to localStorage and ships no telemetry', () => {
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("STORAGE_KEY = 'nexus.hk-series.read'");
    expect(island).toContain('window.localStorage');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
    expect(island).toContain('role="progressbar"');
    expect(island).toContain('aria-valuenow={readCount}');
  });

  it('the mega hub renders the strip from the dict and passes every card through', () => {
    const hub = read(HUB);
    expect(hub).toContain("import { HkSeriesProgress }");
    expect(hub).toContain('<HkSeriesProgress cards={chapters} copy={dict.home.hkProgress} />');
    // The dict-driven grid belongs to the island now; the page must not hand-roll one.
    expect(hub).not.toContain('<ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">');
  });

  it('both locales carry the progress copy (Traditional HK script in zh)', () => {
    const dict = read(DICT);
    expect(dict).toContain("reset: '重設'");
    expect(dict).toContain("mark: '已讀'");
    expect(dict).toContain("readCta: '讀章節'");
    expect(dict).toContain("readCta: 'READ THE CHAPTER'");
    expect(dict).toContain("quizBadge: '測驗'");
    expect(dict).toContain("quizBadge: 'QUIZ'");
    expect(dict).toContain("realSearchBadge: 'REAL SEARCH'");
    expect(dict).toContain("done: '已讀 {read} ／ 共 {total} 章'");
    expect(dict).toContain("done: '{read} of {total} chapters read'");
    expect(dict).toContain("reset: 'Reset marks'");
  });
});
