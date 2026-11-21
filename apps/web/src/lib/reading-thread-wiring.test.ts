import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1517 — the reading thread is wired, and it is wired to the same read-state the rest of the
 * product writes (`nexus.hk-series.read`), so a reader who has been reading the series never
 * wakes up to an empty trail.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/guides/page.tsx';
const ISLAND = 'apps/web/src/components/reading-thread.tsx';
const ENGINE = 'apps/web/src/lib/reading-thread.ts';
const HELPER = 'apps/web/src/lib/chapter-read.ts';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1517 the reading thread wiring', () => {
  it('the guides index renders the island in mock mode, before the world guide', () => {
    const page = read(PAGE);
    expect(page).toContain("import { ReadingThread } from '@/components/reading-thread';");
    expect(page).toContain('<ReadingThread guides={guides} copy={dict.growth.readingThread} />');
    const thread = page.indexOf('<ReadingThread guides={guides}');
    const beacon = page.indexOf('<WorldGuideBeacon');
    expect(thread).toBeGreaterThan(-1);
    expect(beacon).toBeGreaterThan(thread);
  });

  it('the island reads the SAME local key the progress strip and the stamps write', () => {
    const island = read(ISLAND);
    expect(island).toContain("from '@/lib/chapter-read'");
    expect(island).toContain('readChapters()');
    expect(read(HELPER)).toContain("CHAPTER_READ_KEY = 'nexus.hk-series.read'");
  });

  it('the island renders nothing until the read-set is known', () => {
    // server and first paint agree on the empty state; no flash of a ranking nobody earned.
    expect(read(ISLAND)).toContain('ready ? readingThread(');
  });

  it('the engine is pure and the island carries no network of its own', () => {
    const island = read(ISLAND);
    expect(island).toContain("'use client';");
    expect(island).not.toContain('fetch(');
    expect(read(ENGINE)).not.toContain('fetch(');
    expect(read(ENGINE)).toContain('export function readingThread(');
  });

  it('both arms carry the copy, and the tour teaches it', () => {
    const dict = read(DICT);
    expect(dict).toContain('readingThread: {');
    // D1521: the counters and the 《title》 wrapper are TEMPLATES, not functions - a function in
    // this payload is what made Next.js refuse the whole page at render time.
    expect(dict).toContain("progress: '\u5df2\u8b80 {read} / {total} \u7ae0'");
    expect(dict).toContain("percent: '\u5b8c\u6210\u5ea6 {percent}%'");
    expect(dict).toContain("via: '\u300a{title}\u300b'");
    expect(dict).toContain("progress: '{read} of {total} chapters read'");
    expect(dict).toContain("percent: '{percent}% complete'");
    expect(dict).toContain("title: '續讀線 · /guides'");
    expect(dict).toContain("title: 'Reading thread · /guides'");
  });
});
