import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mockGuides } from './mock';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');

/** D1594 — the stamp tracker's total must be the real corpus size, not the 106-chip clock. */
describe('stamp tracker total', () => {
  it('mirrors the full HK corpus and matches the copy promise', () => {
    const corpus = mockGuides('zh-HK').filter((g) => g.slug.startsWith('hk-'));
    expect(corpus.length).toBe(191);
    expect(new Set(corpus.map((g) => g.slug)).size).toBe(corpus.length);
    const page = readFileSync(join(repoRoot, 'apps/web/app/stamp/page.tsx'), 'utf8');
    expect(page).toContain("mockGuides(locale).filter((guide) => guide.slug.startsWith('hk-'))");
    expect(page).toContain('href: `/guides/${guide.slug}`');
    expect(page).not.toContain('entries={clock.map');
  });
});
