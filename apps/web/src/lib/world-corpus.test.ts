import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1487 — the atlas must surface the WHOLE corpus, not just the 106 curated hour chips.
 * Counts and links are derived from the seed at render time; no hand-maintained list can
 * fall behind the series again.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const WORLD = 'apps/web/app/world/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1487 the atlas full-corpus section', () => {
  it('derives every chapter and its count from the seed at render time', () => {
    const world = read(WORLD);
    expect(world).toContain("import { mockGuides } from '@/lib/mock'");
    expect(world).toContain("const corpus = mockGuides(locale).filter((guide) => guide.slug.startsWith('hk-'));");
    expect(world).toContain('t.corpusCount(corpus.length)');
    expect(world).toContain('corpus.map((guide, index) =>');
    expect(world).toContain('href={`/guides/${guide.slug}`}');
  });

  it('keeps the curated 106-chip clock but states the full corpus count honestly', () => {
    const world = read(WORLD);
    expect(world).toContain('const clock: Chip[] = dict.home.hkHub.clock;');
    expect(world).toContain('106 hour chips');
  });

  it('carries derived-count copy in both authored arms', () => {
    const dict = read(DICT);
    expect(dict).toContain('corpusCount: (n) =>');
    expect(dict).toContain('全系列 ${n} 章');
    expect(dict).toContain('${n} chapters in the full corpus');
    expect(dict).toContain("corpusTitle: '全系列 · 每一章都是一扇門'");
    expect(dict).toContain("corpusTitle: 'The full corpus · every chapter a door'");
  });

  it('no stale chapter-count claim survives in the dictionary', () => {
    const dict = read(DICT);
    expect(dict).not.toContain('one hundred and six chapters');
    expect(dict).not.toContain('一百零六章反覆走完一個香港');
    expect(dict).not.toContain('Newest: Chapter 106');
    expect(dict).not.toContain('105 章');
  });
});
