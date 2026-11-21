import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1530 — the chapter radar is wired into the chapter page, on both planes, and its copy exists in
 * both arms. The radar is a SERVER component (no read-state, no network, nothing to hydrate), which
 * is why no boundary leg is needed for it — but the copy is strings anyway.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/guides/[slug]/page.tsx';
const COMPONENT = 'apps/web/src/components/chapter-radar.tsx';
const ENGINE = 'apps/web/src/lib/reading-thread.ts';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1530 the chapter radar wiring', () => {
  it('the chapter page renders the radar beside the live companion', () => {
    const page = read(PAGE);
    expect(page).toContain("import { ChapterRadar } from '@/components/chapter-radar';");
    expect(page).toContain('<ChapterRadar guides={corpus} slug={guide.slug} copy={dict.growth.chapterRadar} />');
    const radar = page.indexOf('<ChapterRadar');
    const ask = page.indexOf('<ChapterAskLive');
    expect(radar).toBeGreaterThan(ask);
  });

  it('the radar reads the SAME corpus the index serves, so both planes answer', () => {
    const page = read(PAGE);
    expect(page).toContain("import { guideBySlug, guideList } from '@/lib/data';");
    expect(page).toContain('const corpus = (await guideList(locale)).data.items;');
    // not gated on a data mode: the engine is pure over whatever the plane served.
    expect(page).not.toContain('IS_MOCK');
  });

  it('the radar is a server component — nothing to hydrate, nothing to cross', () => {
    expect(read(COMPONENT)).not.toContain("'use client'");
    expect(read(COMPONENT)).toContain('export function ChapterRadar');
  });

  it('the engine exports the one-directional affinity the radar uses', () => {
    expect(read(ENGINE)).toContain('export function relatedChapters(');
  });

  it('both arms carry the copy', () => {
    const dict = read(DICT);
    expect(dict).toContain('chapterRadar: {');
    expect(dict).toContain("title: '讀完這章，可以接著讀'");
    expect(dict).toContain("title: 'Finished this chapter? Read these next'");
    expect(dict).toContain("because: '同同你讀的這章'");
    expect(dict).toContain("because: 'Neighbours of the chapter you just read'");
  });
});
