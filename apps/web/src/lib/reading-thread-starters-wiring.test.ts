import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1532 — the empty state of the reading thread is now a set of doors, not a shrug.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/reading-thread.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1532 the starter doors', () => {
  it('the island computes the hubs when the read-set is empty', () => {
    const island = read(ISLAND);
    expect(island).toContain("import { readingThread, starterChapters, threadProgress } from '@/lib/reading-thread';");
    expect(island).toContain('const starters = ready && progress.read === 0 ? starterChapters(guides, { steps: 3 }) : [];');
    expect(island).toContain('data-testid="reading-thread-starters"');
  });

  it('the starters are NOT offered once the reader has history', () => {
    // the condition carries `progress.read === 0`, so the hubs disappear the moment there is a
    // thread to show instead.
    const island = read(ISLAND);
    expect(island).toContain('progress.read === 0 && starters.length > 0');
  });

  it('both arms carry the starter copy', () => {
    const dict = read(DICT);
    expect(dict).toContain('starterTitle:');
    expect(dict).toContain('starterBecause:');
    // D1532: a sentence, not a number. The degree saturates on the shipped corpus (every chapter
    // already connects to all 179 others), so a count would be true and meaningless.
    expect(dict).toContain("starterBecause: '全書相連度最高的起點之一");
    expect(dict).toContain("starterBecause: 'One of the best-connected starting points");
  });

  it('the starter copy is still all strings where it crosses the boundary', () => {
    // starterBecause is a FUNCTION, but it is read inside the island's own render, not handed to
    // another client component - so it is fine here. What must hold is that the island does not
    // forward the whole copy object anywhere new.
    const island = read(ISLAND);
    expect(island).not.toContain('copy={');
  });
});
