import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** D1600 — /world renders the measured layer band, server-only, in both arms. */
describe('layer census wiring', () => {
  it('the world page feeds the band from the real clock and layers', () => {
    const page = read('apps/web/app/world/page.tsx');
    expect(page).toContain("import { LayerCensusBand } from '@/components/layer-census-band'");
    expect(page).toContain('<LayerCensusBand chips={clock} layers={t.layers} copy={t.layerCensus} />');
  });

  it('the band stays a local server component', () => {
    const ui = read('apps/web/src/components/layer-census-band.tsx');
    expect(ui).not.toContain("'use client'");
    expect(ui).toContain('layerCensus(chips, layers)');
    expect(ui).not.toMatch(/\bfetch\s*\(/);
  });

  it('both authored arms carry the copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("eyebrow: '七層明細 · 實測'");
    expect(dict).toContain("eyebrow: 'SEVEN LAYERS · MEASURED'");
  });
});
