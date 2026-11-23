import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('world census wiring', () => {
  it('the /world page renders the measured census band', () => {
    const page = read('apps/web/app/world/page.tsx');
    expect(page).toContain("import { WorldCensusBand } from '@/components/world-census-band'");
    expect(page).toContain('<WorldCensusBand guides={corpus} copy={t.census} />');
  });

  it('the band is local-first and never fabricates a number', () => {
    const ui = read('apps/web/src/components/world-census-band.tsx');
    expect(ui.startsWith("'use client';")).toBe(true);
    expect(ui).toContain('worldCensus(guides)');
    expect(ui).toContain('endlessDoors(guides');
    expect(ui).toContain('readChapters()');
    expect(ui).not.toContain('fetch(');
  });

  it('both arms carry the census copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("eyebrow: '世界普查 · 實測'");
    expect(dict).toContain("eyebrow: 'WORLD CENSUS · MEASURED'");
    expect(dict).toContain('re-entry doors');
  });
});
